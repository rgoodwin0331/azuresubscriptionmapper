import { app } from '@azure/functions';
import sql from 'mssql';

// ─────────────────────────────────────────────────────────────
// Connection pool
// ─────────────────────────────────────────────────────────────
let pool = null;

const getPool = async () => {
  if (!pool) {
    const connStr = process.env.AzureSQLConnectionString;
    if (!connStr) throw new Error('Missing AzureSQLConnectionString environment variable');
    try {
      pool = await sql.connect(connStr);
    } catch (err) {
      pool = null; // reset so next request retries
      throw err;
    }
  }
  return pool;
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const getPagination = (request) => {
  const page     = Math.max(1, parseInt(request.query.get('page')      || '1',  10));
  const pageSize = Math.min(200, Math.max(1, parseInt(request.query.get('page_size') || '50', 10)));
  const offset   = (page - 1) * pageSize;
  return { page, pageSize, offset };
};

// Validate a UUID / GUID string (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
const isValidGuid = (str) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str || '');

// ─────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────
app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (_request, _context) => ({
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
    body: 'API is running'
  })
});

// ─────────────────────────────────────────────────────────────
// Summary
// Returns: total_accounts, total_subscriptions, total_unknown,
//          accounts_with_multiple_subscriptions
// Tables:  dbo.accounts, dbo.subscriptions, dbo.subscriptions_unknown
// ─────────────────────────────────────────────────────────────
app.http('summary', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (_request, context) => {
    try {
      const db = await getPool();
      const result = await db.request().query(`
        SELECT
          (SELECT COUNT(*)  FROM dbo.accounts)              AS total_accounts,
          (SELECT COUNT(*)  FROM dbo.subscriptions)         AS total_subscriptions,
          (SELECT COUNT(*)  FROM dbo.subscriptions_unknown) AS total_unknown,
          (SELECT COUNT(*)  FROM (
              SELECT account_id
              FROM   dbo.subscriptions
              GROUP  BY account_id
              HAVING COUNT(*) >= 2
          ) m)                                              AS accounts_with_multiple_subscriptions
      `);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.recordset[0])
      };
    } catch (err) {
      context.error('Summary error:', err);
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// Accounts list  (paginated + search)
// Columns used: dbo.accounts.account_id, name, company_id
//               dbo.subscriptions.subscription_id (count)
// ─────────────────────────────────────────────────────────────
app.http('accounts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const db = await getPool();
      const { page, pageSize, offset } = getPagination(request);
      const search = request.query.get('search') || '';

      const whereClause = search ? 'WHERE a.[name] LIKE @search OR a.company_id LIKE @search' : '';

      const countResult = await db.request()
        .input('search', sql.NVarChar(255), `%${search}%`)
        .query(`SELECT COUNT(*) AS total FROM dbo.accounts a ${whereClause}`);

      const dataResult = await db.request()
        .input('search',   sql.NVarChar(255), `%${search}%`)
        .input('offset',   sql.Int, offset)
        .input('pageSize', sql.Int, pageSize)
        .query(`
          SELECT
            a.account_id,
            a.[name]      AS account_name,
            a.company_id,
            COUNT(s.subscription_id) AS subscription_count
          FROM dbo.accounts a
          LEFT JOIN dbo.subscriptions s ON a.account_id = s.account_id
          ${whereClause}
          GROUP BY a.account_id, a.[name], a.company_id
          ORDER BY a.[name]
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

      const total = countResult.recordset[0].total;
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: dataResult.recordset,
          pagination: { page, page_size: pageSize, total_records: total, total_pages: Math.ceil(total / pageSize) }
        })
      };
    } catch (err) {
      context.error('Accounts error:', err);
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// Account detail  GET /api/accounts/{accountId}
// Columns: dbo.accounts.account_id, name (→ account_name), company_id
//          dbo.subscriptions.subscription_id, subscription_name, subscription_guid
// ─────────────────────────────────────────────────────────────
app.http('account-detail', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'accounts/{accountId}',
  handler: async (request, context) => {
    try {
      const db        = await getPool();
      const accountId = parseInt(request.params.accountId, 10);
      if (isNaN(accountId)) {
        return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid account ID' }) };
      }

      const accountResult = await db.request()
        .input('accountId', sql.Int, accountId)
        .query(`
          SELECT account_id, [name] AS account_name, company_id
          FROM   dbo.accounts
          WHERE  account_id = @accountId
        `);

      if (accountResult.recordset.length === 0) {
        return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Account not found' }) };
      }

      const subsResult = await db.request()
        .input('accountId', sql.Int, accountId)
        .query(`
          SELECT subscription_id, subscription_name, subscription_guid
          FROM   dbo.subscriptions
          WHERE  account_id = @accountId
          ORDER  BY subscription_name
        `);

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account:       accountResult.recordset[0],
          subscriptions: subsResult.recordset
        })
      };
    } catch (err) {
      context.error('Account detail error:', err);
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// Subscriptions list  GET /api/subscriptions  (paginated + search)
// Joins dbo.subscriptions → dbo.accounts on account_id
// Note: dbo.accounts column is [name], aliased as account_name
// ─────────────────────────────────────────────────────────────
app.http('subscriptions-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'subscriptions',
  handler: async (request, context) => {
    try {
      const db = await getPool();
      const { page, pageSize, offset } = getPagination(request);
      const search = request.query.get('search') || '';

      const whereClause = search
        ? 'WHERE s.subscription_name LIKE @search OR a.[name] LIKE @search OR CAST(s.subscription_guid AS NVARCHAR(36)) LIKE @search'
        : '';

      const countResult = await db.request()
        .input('search', sql.NVarChar(255), `%${search}%`)
        .query(`
          SELECT COUNT(*) AS total
          FROM   dbo.subscriptions s
          LEFT JOIN dbo.accounts a ON s.account_id = a.account_id
          ${whereClause}
        `);

      const dataResult = await db.request()
        .input('search',   sql.NVarChar(255), `%${search}%`)
        .input('offset',   sql.Int, offset)
        .input('pageSize', sql.Int, pageSize)
        .query(`
          SELECT
            s.subscription_id,
            s.subscription_name,
            s.subscription_guid,
            s.account_id,
            a.[name]      AS account_name,
            a.company_id
          FROM dbo.subscriptions s
          LEFT JOIN dbo.accounts a ON s.account_id = a.account_id
          ${whereClause}
          ORDER BY s.subscription_name
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

      const total = countResult.recordset[0].total;
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: dataResult.recordset,
          pagination: { page, page_size: pageSize, total_records: total, total_pages: Math.ceil(total / pageSize) }
        })
      };
    } catch (err) {
      context.error('Subscriptions error:', err);
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// Unknown subscriptions  GET /api/unknown  (paginated)
// Table: dbo.subscriptions_unknown  (PK = id, not subscription_id)
// ─────────────────────────────────────────────────────────────
app.http('unknown', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const db = await getPool();
      const { page, pageSize, offset } = getPagination(request);

      const countResult = await db.request()
        .query('SELECT COUNT(*) AS total FROM dbo.subscriptions_unknown');

      const dataResult = await db.request()
        .input('offset',   sql.Int, offset)
        .input('pageSize', sql.Int, pageSize)
        .query(`
          SELECT id, subscription_name, subscription_guid
          FROM   dbo.subscriptions_unknown
          ORDER  BY subscription_name
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

      const total = countResult.recordset[0].total;
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: dataResult.recordset,
          pagination: { page, page_size: pageSize, total_records: total, total_pages: Math.ceil(total / pageSize) }
        })
      };
    } catch (err) {
      context.error('Unknown error:', err);
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// CREATE MAPPING  POST /api/create-mapping
//
// Phase 1: always creates a NEW account + its first subscription
// in a single transaction.
//
// Request body (JSON):
//   {
//     "account_name":      "Contoso Finance",     // → dbo.accounts.name  (nvarchar 255)
//     "company_id":        "12345",               // → dbo.accounts.company_id (nvarchar 100)
//     "subscription_name": "Prod Subscription",   // → dbo.subscriptions.subscription_name (nvarchar 255)
//     "subscription_guid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" // → dbo.subscriptions.subscription_guid (uniqueidentifier)
//   }
//
// Duplicate checks (returns 409):
//   - dbo.accounts.name        already exists (case-insensitive)
//   - dbo.accounts.company_id  already exists (case-insensitive)
//   - dbo.subscriptions.subscription_guid already exists
//
// Success response 201:
//   { account_id, subscription_id, account_name, company_id, subscription_name, subscription_guid }
// ─────────────────────────────────────────────────────────────
app.http('create-mapping', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Request body must be valid JSON' })
      };
    }

    // ── Validate required fields ──────────────────────────────
    const account_name      = (body.account_name      || '').trim();
    const company_id        = (body.company_id         || '').trim();
    const subscription_name = (body.subscription_name  || '').trim();
    const subscription_guid = (body.subscription_guid  || '').trim();

    const missing = [];
    if (!account_name)      missing.push('account_name');
    if (!company_id)        missing.push('company_id');
    if (!subscription_name) missing.push('subscription_name');
    if (!subscription_guid) missing.push('subscription_guid');

    if (missing.length > 0) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Missing required fields: ${missing.join(', ')}` })
      };
    }

    // ── Validate GUID format ──────────────────────────────────
    if (!isValidGuid(subscription_guid)) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'subscription_guid must be a valid GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)' })
      };
    }

    // ── Field length guards ───────────────────────────────────
    if (account_name.length > 255) {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'account_name exceeds 255 characters' }) };
    }
    if (company_id.length > 100) {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'company_id exceeds 100 characters' }) };
    }
    if (subscription_name.length > 255) {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'subscription_name exceeds 255 characters' }) };
    }

    try {
      const db = await getPool();

      // ── Duplicate checks ──────────────────────────────────
      // 1. Account name (case-insensitive via COLLATE)
      const dupName = await db.request()
        .input('account_name', sql.NVarChar(255), account_name)
        .query(`SELECT account_id FROM dbo.accounts WHERE [name] = @account_name`);
      if (dupName.recordset.length > 0) {
        return {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `An account named "${account_name}" already exists` })
        };
      }

      // 2. Company ID
      const dupCompany = await db.request()
        .input('company_id', sql.NVarChar(100), company_id)
        .query(`SELECT account_id FROM dbo.accounts WHERE company_id = @company_id`);
      if (dupCompany.recordset.length > 0) {
        return {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Company ID "${company_id}" is already assigned to an existing account` })
        };
      }

      // 3. Subscription GUID
      const dupGuid = await db.request()
        .input('subscription_guid', sql.UniqueIdentifier, subscription_guid)
        .query(`SELECT subscription_id FROM dbo.subscriptions WHERE subscription_guid = @subscription_guid`);
      if (dupGuid.recordset.length > 0) {
        return {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Subscription GUID "${subscription_guid}" already exists in the database` })
        };
      }

      // ── Transactional insert ──────────────────────────────
      // Insert account → capture SCOPE_IDENTITY() → insert subscription
      const insertResult = await db.request()
        .input('account_name',      sql.NVarChar(255),       account_name)
        .input('company_id',        sql.NVarChar(100),       company_id)
        .input('subscription_name', sql.NVarChar(255),       subscription_name)
        .input('subscription_guid', sql.UniqueIdentifier,    subscription_guid)
        .query(`
          BEGIN TRAN;

          INSERT INTO dbo.accounts ([name], company_id)
          VALUES (@account_name, @company_id);

          DECLARE @new_account_id INT = SCOPE_IDENTITY();

          INSERT INTO dbo.subscriptions (account_id, subscription_name, subscription_guid)
          VALUES (@new_account_id, @subscription_name, @subscription_guid);

          DECLARE @new_subscription_id INT = SCOPE_IDENTITY();

          COMMIT TRAN;

          SELECT
            @new_account_id      AS account_id,
            @new_subscription_id AS subscription_id;
        `);

      const newIds = insertResult.recordset[0];
      context.log(`Created mapping — account_id: ${newIds.account_id}, subscription_id: ${newIds.subscription_id}`);

      return {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id:        newIds.account_id,
          subscription_id:   newIds.subscription_id,
          account_name,
          company_id,
          subscription_name,
          subscription_guid
        })
      };

    } catch (err) {
      context.error('Create mapping error:', err);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Database error: ' + err.message })
      };
    }
  }
});

app.setup({ enableHttpStream: true });
