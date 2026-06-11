import { app } from '@azure/functions';
import sql from 'mssql';

// ─────────────────────────────────────────────────────────────────────────────
// Database connection
// ─────────────────────────────────────────────────────────────────────────────
const getConnectionString = () => process.env.AzureSQLConnectionString;

let pool = null;
const getPool = async () => {
  if (!pool) {
    const connStr = getConnectionString();
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getPagination(request) {
  const page     = Math.max(1, parseInt(request.query.get('page')      || '1',  10));
  const pageSize = Math.min(200, Math.max(1, parseInt(request.query.get('page_size') || '50', 10)));
  const offset   = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

function jsonResponse(status, body) {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────────────────────
app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async () => ({
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
    body: 'API is running'
  })
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/summary
// Returns counts for all four dashboard cards
// ─────────────────────────────────────────────────────────────────────────────
app.http('summary', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const db     = await getPool();
      const result = await db.request().query(`
        SELECT
          (SELECT COUNT(*) FROM dbo.accounts)              AS total_accounts,
          (SELECT COUNT(*) FROM dbo.subscriptions)         AS total_subscriptions,
          (SELECT COUNT(*) FROM dbo.subscriptions_unknown) AS total_unknown,
          (SELECT COUNT(*) FROM (
              SELECT account_id
              FROM dbo.subscriptions
              GROUP BY account_id
              HAVING COUNT(*) >= 2
          ) m)                                             AS accounts_with_multiple_subscriptions
      `);
      return jsonResponse(200, result.recordset[0]);
    } catch (err) {
      context.error('Summary error:', err);
      return jsonResponse(500, { error: err.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounts  — paginated + searchable
// ─────────────────────────────────────────────────────────────────────────────
app.http('accounts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const db                    = await getPool();
      const { page, pageSize, offset } = getPagination(request);
      const search                = request.query.get('search') || '';

      const whereClause = search ? `WHERE a.[name] LIKE @search` : '';

      const countResult = await db.request()
        .input('search', sql.NVarChar, `%${search}%`)
        .query(`SELECT COUNT(*) AS total FROM dbo.accounts a ${whereClause}`);

      const dataResult = await db.request()
        .input('search',   sql.NVarChar, `%${search}%`)
        .input('offset',   sql.Int,      offset)
        .input('pageSize', sql.Int,      pageSize)
        .query(`
          SELECT
            a.account_id,
            a.[name]     AS account_name,
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
      return jsonResponse(200, {
        data: dataResult.recordset,
        pagination: {
          page,
          page_size:    pageSize,
          total_records: total,
          total_pages:  Math.ceil(total / pageSize)
        }
      });
    } catch (err) {
      context.error('Accounts error:', err);
      return jsonResponse(500, { error: err.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounts/{accountId}  — single account + its subscriptions
// ─────────────────────────────────────────────────────────────────────────────
app.http('account-detail', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'accounts/{accountId}',
  handler: async (request, context) => {
    try {
      const db        = await getPool();
      const accountId = parseInt(request.params.accountId, 10);
      if (isNaN(accountId)) return jsonResponse(400, { error: 'Invalid accountId' });

      const accountResult = await db.request()
        .input('accountId', sql.Int, accountId)
        .query(`
          SELECT account_id, [name] AS account_name, company_id
          FROM dbo.accounts
          WHERE account_id = @accountId
        `);

      if (accountResult.recordset.length === 0)
        return jsonResponse(404, { error: 'Account not found' });

      const subsResult = await db.request()
        .input('accountId', sql.Int, accountId)
        .query(`
          SELECT subscription_id, subscription_name, subscription_guid
          FROM dbo.subscriptions
          WHERE account_id = @accountId
          ORDER BY subscription_name
        `);

      return jsonResponse(200, {
        account:       accountResult.recordset[0],
        subscriptions: subsResult.recordset
      });
    } catch (err) {
      context.error('Account detail error:', err);
      return jsonResponse(500, { error: err.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscriptions  — paginated + searchable
// ─────────────────────────────────────────────────────────────────────────────
app.http('subscriptions-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'subscriptions',
  handler: async (request, context) => {
    try {
      const db                    = await getPool();
      const { page, pageSize, offset } = getPagination(request);
      const search                = request.query.get('search') || '';

      const whereClause = search
        ? `WHERE (s.subscription_name LIKE @search OR a.[name] LIKE @search)`
        : '';

      const countResult = await db.request()
        .input('search', sql.NVarChar, `%${search}%`)
        .query(`
          SELECT COUNT(*) AS total
          FROM dbo.subscriptions s
          LEFT JOIN dbo.accounts a ON s.account_id = a.account_id
          ${whereClause}
        `);

      const dataResult = await db.request()
        .input('search',   sql.NVarChar, `%${search}%`)
        .input('offset',   sql.Int,      offset)
        .input('pageSize', sql.Int,      pageSize)
        .query(`
          SELECT
            s.subscription_id,
            s.subscription_name,
            s.subscription_guid,
            s.account_id,
            a.[name]     AS account_name,
            a.company_id
          FROM dbo.subscriptions s
          LEFT JOIN dbo.accounts a ON s.account_id = a.account_id
          ${whereClause}
          ORDER BY s.subscription_name
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

      const total = countResult.recordset[0].total;
      return jsonResponse(200, {
        data: dataResult.recordset,
        pagination: {
          page,
          page_size:     pageSize,
          total_records: total,
          total_pages:   Math.ceil(total / pageSize)
        }
      });
    } catch (err) {
      context.error('Subscriptions error:', err);
      return jsonResponse(500, { error: err.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/unknown  — paginated list of dbo.subscriptions_unknown
// ─────────────────────────────────────────────────────────────────────────────
app.http('unknown', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const db                    = await getPool();
      const { page, pageSize, offset } = getPagination(request);

      const countResult = await db.request()
        .query(`SELECT COUNT(*) AS total FROM dbo.subscriptions_unknown`);

      const dataResult = await db.request()
        .input('offset',   sql.Int, offset)
        .input('pageSize', sql.Int, pageSize)
        .query(`
          SELECT id, subscription_name, subscription_guid
          FROM dbo.subscriptions_unknown
          ORDER BY subscription_name
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

      const total = countResult.recordset[0].total;
      return jsonResponse(200, {
        data: dataResult.recordset,
        pagination: {
          page,
          page_size:     pageSize,
          total_records: total,
          total_pages:   Math.ceil(total / pageSize)
        }
      });
    } catch (err) {
      context.error('Unknown error:', err);
      return jsonResponse(500, { error: err.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/create-mapping
// Phase 1: Creates a NEW account + its FIRST subscription in one transaction
// ─────────────────────────────────────────────────────────────────────────────
app.http('create-mapping', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const body = await request.json();
      const { account_name, company_id, subscription_name, subscription_guid } = body;

      // ── Field presence validation ──────────────────────────────────────────
      const missing = [];
      if (!account_name?.trim())       missing.push('account_name');
      if (!company_id?.trim())         missing.push('company_id');
      if (!subscription_name?.trim())  missing.push('subscription_name');
      if (!subscription_guid?.trim())  missing.push('subscription_guid');
      if (missing.length)
        return jsonResponse(400, { error: `Missing required fields: ${missing.join(', ')}` });

      // ── GUID format validation ─────────────────────────────────────────────
      if (!GUID_RE.test(subscription_guid.trim()))
        return jsonResponse(400, {
          error: 'subscription_guid must be a valid GUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
        });

      // ── Length validation ──────────────────────────────────────────────────
      if (account_name.trim().length    > 255) return jsonResponse(400, { error: 'account_name exceeds 255 characters' });
      if (company_id.trim().length      > 100) return jsonResponse(400, { error: 'company_id exceeds 100 characters' });
      if (subscription_name.trim().length > 255) return jsonResponse(400, { error: 'subscription_name exceeds 255 characters' });

      const db = await getPool();

      // ── Duplicate checks ───────────────────────────────────────────────────
      const dupAccount = await db.request()
        .input('account_name', sql.NVarChar(255), account_name.trim())
        .query(`SELECT 1 FROM dbo.accounts WHERE [name] = @account_name`);
      if (dupAccount.recordset.length)
        return jsonResponse(409, { error: `An account named "${account_name.trim()}" already exists.` });

      const dupCompany = await db.request()
        .input('company_id', sql.NVarChar(100), company_id.trim())
        .query(`SELECT 1 FROM dbo.accounts WHERE company_id = @company_id`);
      if (dupCompany.recordset.length)
        return jsonResponse(409, { error: `Company ID "${company_id.trim()}" is already assigned to another account.` });

      const dupGuid = await db.request()
        .input('subscription_guid', sql.UniqueIdentifier, subscription_guid.trim())
        .query(`SELECT 1 FROM dbo.subscriptions WHERE subscription_guid = @subscription_guid`);
      if (dupGuid.recordset.length)
        return jsonResponse(409, { error: `Subscription GUID "${subscription_guid.trim()}" already exists.` });

      // ── Transactional insert ───────────────────────────────────────────────
      const insertResult = await db.request()
        .input('account_name',       sql.NVarChar(255),    account_name.trim())
        .input('company_id',         sql.NVarChar(100),    company_id.trim())
        .input('subscription_name',  sql.NVarChar(255),    subscription_name.trim())
        .input('subscription_guid',  sql.UniqueIdentifier, subscription_guid.trim())
        .query(`
          BEGIN TRAN;

            INSERT INTO dbo.accounts ([name], company_id)
            VALUES (@account_name, @company_id);

            DECLARE @new_account_id INT = SCOPE_IDENTITY();

            INSERT INTO dbo.subscriptions (account_id, subscription_name, subscription_guid)
            VALUES (@new_account_id, @subscription_name, @subscription_guid);

          COMMIT TRAN;

          SELECT @new_account_id AS new_account_id;
        `);

      const newAccountId = insertResult.recordset[0]?.new_account_id;
      context.log(`Created account ${newAccountId} with subscription ${subscription_guid.trim()}`);

      return jsonResponse(201, {
        message:        'Account and subscription created successfully.',
        new_account_id: newAccountId
      });

    } catch (err) {
      context.error('create-mapping error:', err);
      return jsonResponse(500, { error: err.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounts-list
// Phase 2: Returns a lightweight list of all accounts for the dropdown
// (account_id + name only — used by the "Add Subscription to Existing Account" modal)
// ─────────────────────────────────────────────────────────────────────────────
app.http('accounts-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const db     = await getPool();
      const search = request.query.get('search') || '';

      const result = await db.request()
        .input('search', sql.NVarChar, `%${search}%`)
        .query(`
          SELECT account_id, [name] AS account_name, company_id
          FROM dbo.accounts
          ${search ? 'WHERE [name] LIKE @search' : ''}
          ORDER BY [name]
        `);

      return jsonResponse(200, { data: result.recordset });
    } catch (err) {
      context.error('accounts-list error:', err);
      return jsonResponse(500, { error: err.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/add-subscription
// Phase 2: Adds a new subscription to an EXISTING account
// ─────────────────────────────────────────────────────────────────────────────
app.http('add-subscription', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const body = await request.json();
      const { account_id, subscription_name, subscription_guid } = body;

      // ── Field presence validation ──────────────────────────────────────────
      const missing = [];
      if (!account_id)                 missing.push('account_id');
      if (!subscription_name?.trim())  missing.push('subscription_name');
      if (!subscription_guid?.trim())  missing.push('subscription_guid');
      if (missing.length)
        return jsonResponse(400, { error: `Missing required fields: ${missing.join(', ')}` });

      // ── GUID format validation ─────────────────────────────────────────────
      if (!GUID_RE.test(subscription_guid.trim()))
        return jsonResponse(400, {
          error: 'subscription_guid must be a valid GUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
        });

      // ── Length validation ──────────────────────────────────────────────────
      if (subscription_name.trim().length > 255)
        return jsonResponse(400, { error: 'subscription_name exceeds 255 characters' });

      const db = await getPool();

      // ── Verify account exists ──────────────────────────────────────────────
      const accountCheck = await db.request()
        .input('account_id', sql.Int, parseInt(account_id, 10))
        .query(`SELECT account_id, [name] AS account_name FROM dbo.accounts WHERE account_id = @account_id`);
      if (accountCheck.recordset.length === 0)
        return jsonResponse(404, { error: `Account ID ${account_id} not found.` });

      const accountName = accountCheck.recordset[0].account_name;

      // ── Duplicate GUID check ───────────────────────────────────────────────
      const dupGuid = await db.request()
        .input('subscription_guid', sql.UniqueIdentifier, subscription_guid.trim())
        .query(`SELECT 1 FROM dbo.subscriptions WHERE subscription_guid = @subscription_guid`);
      if (dupGuid.recordset.length)
        return jsonResponse(409, { error: `Subscription GUID "${subscription_guid.trim()}" already exists.` });

      // ── Insert ─────────────────────────────────────────────────────────────
      const insertResult = await db.request()
        .input('account_id',        sql.Int,              parseInt(account_id, 10))
        .input('subscription_name', sql.NVarChar(255),    subscription_name.trim())
        .input('subscription_guid', sql.UniqueIdentifier, subscription_guid.trim())
        .query(`
          INSERT INTO dbo.subscriptions (account_id, subscription_name, subscription_guid)
          VALUES (@account_id, @subscription_name, @subscription_guid);

          SELECT SCOPE_IDENTITY() AS new_subscription_id;
        `);

      const newSubId = insertResult.recordset[0]?.new_subscription_id;
      context.log(`Added subscription ${newSubId} to account ${account_id}`);

      return jsonResponse(201, {
        message:             `Subscription added to account "${accountName}" successfully.`,
        new_subscription_id: newSubId,
        account_id:          parseInt(account_id, 10),
        account_name:        accountName
      });

    } catch (err) {
      context.error('add-subscription error:', err);
      return jsonResponse(500, { error: err.message });
    }
  }
});

app.setup({ enableHttpStream: true });
