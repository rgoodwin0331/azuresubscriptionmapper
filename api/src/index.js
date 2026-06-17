import { app } from '@azure/functions';
import sql from 'mssql';

// ─────────────────────────────────────────────────────────────
// Database connection pool
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// Pagination helper
// ─────────────────────────────────────────────────────────────
const getPagination = (request) => {
  const page     = Math.max(1, parseInt(request.query.get('page')  || '1',  10));
  const pageSize = Math.max(1, parseInt(request.query.get('limit') || '25', 10));
  const offset   = (page - 1) * pageSize;
  return { page, pageSize, offset };
};

// ─────────────────────────────────────────────────────────────
// GUID validation helper
// ─────────────────────────────────────────────────────────────
const isValidGuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ─────────────────────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────────────────────
app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    return {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: 'API is running'
    };
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/summary
// FIX: was only returning total_accounts.
//      Now returns all four dashboard card values.
//      FIX: table names use dbo schema prefix.
//      FIX: response keys match exactly what index.html reads:
//           totalAccounts, mappedSubscriptions,
//           unknownSubscriptions, accountsWithMultipleSubs
// ─────────────────────────────────────────────────────────────
app.http('summary', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT
          (SELECT COUNT(*) FROM dbo.accounts)                AS totalAccounts,
          (SELECT COUNT(*) FROM dbo.subscriptions)           AS mappedSubscriptions,
          (SELECT COUNT(*) FROM dbo.subscriptions_unknown)   AS unknownSubscriptions,
          (SELECT COUNT(*) FROM (
              SELECT account_id
              FROM dbo.subscriptions
              GROUP BY account_id
              HAVING COUNT(*) >= 2
          ) m)                                               AS accountsWithMultipleSubs
      `);

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.recordset[0])
      };
    } catch (error) {
      context.error('Summary error:', error);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message })
      };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/accounts?page=&limit=&search=
// FIX: column is [name] not account_name — aliased as account_name
//      for frontend consistency.
//      FIX: response wraps in { data, total, page, totalPages }
//           to match what index.html expects.
// ─────────────────────────────────────────────────────────────
app.http('accounts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const { page, pageSize, offset } = getPagination(request);
      const search = (request.query.get('search') || '').trim();

      const countReq = pool.request();
      const dataReq  = pool.request();

      let countQuery = `SELECT COUNT(*) AS total FROM dbo.accounts`;
      let dataQuery  = `
        SELECT
          a.account_id,
          a.[name]       AS account_name,
          a.company_id,
          COUNT(s.subscription_id) AS subscription_count
        FROM dbo.accounts a
        LEFT JOIN dbo.subscriptions s ON a.account_id = s.account_id
      `;

      if (search) {
        countQuery += ` WHERE [name] LIKE @search`;
        dataQuery  += ` WHERE a.[name] LIKE @search`;
        countReq.input('search', sql.NVarChar, `%${search}%`);
        dataReq.input('search',  sql.NVarChar, `%${search}%`);
      }

      dataQuery += `
        GROUP BY a.account_id, a.[name], a.company_id
        ORDER BY a.[name]
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
      `;

      dataReq.input('offset',   sql.Int, offset);
      dataReq.input('pageSize', sql.Int, pageSize);

      const countResult = await countReq.query(countQuery);
      const dataResult  = await dataReq.query(dataQuery);
      const total       = countResult.recordset[0].total;

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data:       dataResult.recordset,
          total,
          page,
          totalPages: Math.ceil(total / pageSize)
        })
      };
    } catch (error) {
      context.error('Accounts error:', error);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message })
      };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/accounts/{accountId}   — account detail
// FIX: column is [name] not account_name — aliased as account_name
// ─────────────────────────────────────────────────────────────
app.http('account-detail', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'accounts/{id}',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const accountId = parseInt(request.params.id, 10);

      if (isNaN(accountId)) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Invalid account ID.' })
        };
      }

      // 1) Account metadata
      const accountResult = await pool.request()
        .input('accountId', sql.Int, accountId)
        .query(`
          SELECT account_id, [name] AS name, company_id, tenant_id, created_at
          FROM dbo.accounts
          WHERE account_id = @accountId
        `);

      if (!accountResult.recordset.length) {
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Account not found.' })
        };
      }

      const account = accountResult.recordset[0];

      // 2) Subscriptions for this account
      const subsResult = await pool.request()
        .input('accountId', sql.Int, accountId)
        .query(`
          SELECT subscription_id, subscription_name, subscription_guid
          FROM dbo.subscriptions
          WHERE account_id = @accountId
          ORDER BY subscription_name
        `);

      const subscriptions = subsResult.recordset;

      // 3) Consumed products (SKUs) directly linked to this account
      const skusResult = await pool.request()
        .input('accountId', sql.Int, accountId)
        .query(`
          SELECT id,
                 u_service_offering,
                 u_product_id,
                 u_qty_to_invoice,
                 u_recurring_amount
          FROM dbo.sku_msaz001
          WHERE account_id = @accountId
          ORDER BY u_service_offering, u_product_id
        `);

      const skus = skusResult.recordset;
      const totalRecurring = skus.reduce(
        (sum, s) => sum + (parseFloat(s.u_recurring_amount) || 0), 0
      );

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account,
          subscriptions,
          skus,
          meta: {
            subscription_count: subscriptions.length,
            sku_count: skus.length,
            total_monthly_recurring: totalRecurring
          }
        })
      };

    } catch (err) {
      context.error('account-detail error:', err);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal server error', detail: err.message })
      };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/subscriptions?page=&limit=&search=
// FIX: JOIN uses a.[name] AS account_name (not account_name column)
//      FIX: response wraps in { data, total, page, totalPages }
// ─────────────────────────────────────────────────────────────
app.http('subscriptions-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'subscriptions',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const { page, pageSize, offset } = getPagination(request);
      const search = (request.query.get('search') || '').trim();

      const countReq = pool.request();
      const dataReq  = pool.request();

      let countQuery = `
        SELECT COUNT(*) AS total
        FROM dbo.subscriptions s
        LEFT JOIN dbo.accounts a ON s.account_id = a.account_id
      `;
      let dataQuery = `
        SELECT
          s.subscription_id,
          s.subscription_name,
          s.subscription_guid,
          s.account_id,
          a.[name]     AS account_name,
          a.company_id
        FROM dbo.subscriptions s
        LEFT JOIN dbo.accounts a ON s.account_id = a.account_id
      `;

      if (search) {
        const whereClause = `
          WHERE (s.subscription_name LIKE @search
              OR a.[name]            LIKE @search
              OR a.company_id        LIKE @search)
        `;
        countQuery += whereClause;
        dataQuery  += whereClause;
        countReq.input('search', sql.NVarChar, `%${search}%`);
        dataReq.input('search',  sql.NVarChar, `%${search}%`);
      }

      dataQuery += `
        ORDER BY s.subscription_name
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
      `;

      dataReq.input('offset',   sql.Int, offset);
      dataReq.input('pageSize', sql.Int, pageSize);

      const countResult = await countReq.query(countQuery);
      const dataResult  = await dataReq.query(dataQuery);
      const total       = countResult.recordset[0].total;

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data:       dataResult.recordset,
          total,
          page,
          totalPages: Math.ceil(total / pageSize)
        })
      };
    } catch (error) {
      context.error('Subscriptions error:', error);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message })
      };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/unknown-subscriptions?page=&limit=&search=
// FIX: was querying dbo.subscriptions WHERE guid IS NULL — WRONG.
//      Your schema has a dedicated dbo.subscriptions_unknown table
//      with columns: id, subscription_name, subscription_guid
//      FIX: route name changed to 'unknown-subscriptions' to match
//           what index.html fetches (/api/unknown-subscriptions)
//      FIX: response wraps in { data, total, page, totalPages }
// ─────────────────────────────────────────────────────────────
app.http('unknown-subscriptions', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'unknown-subscriptions',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const { page, pageSize, offset } = getPagination(request);
      const search = (request.query.get('search') || '').trim();

      const countReq = pool.request();
      const dataReq  = pool.request();

      let countQuery = `SELECT COUNT(*) AS total FROM dbo.subscriptions_unknown`;
      let dataQuery  = `
        SELECT id, subscription_name, subscription_guid
        FROM dbo.subscriptions_unknown
      `;

      if (search) {
        const whereClause = `
          WHERE (subscription_name LIKE @search
              OR subscription_guid LIKE @search)
        `;
        countQuery += whereClause;
        dataQuery  += whereClause;
        countReq.input('search', sql.NVarChar, `%${search}%`);
        dataReq.input('search',  sql.NVarChar, `%${search}%`);
      }

      dataQuery += `
        ORDER BY subscription_name
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
      `;

      dataReq.input('offset',   sql.Int, offset);
      dataReq.input('pageSize', sql.Int, pageSize);

      const countResult = await countReq.query(countQuery);
      const dataResult  = await dataReq.query(dataQuery);
      const total       = countResult.recordset[0].total;

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data:       dataResult.recordset,
          total,
          page,
          totalPages: Math.ceil(total / pageSize)
        })
      };
    } catch (error) {
      context.error('Unknown subscriptions error:', error);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message })
      };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/accounts/search?q=<term>
// Typeahead for Modal 2 — Add Subscription to Existing Account
// FIX: column is [name] not account_name — aliased as account_name
// ─────────────────────────────────────────────────────────────
app.http('accounts-search', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'accounts-search',
  handler: async (request, context) => {
    try {
      const q = (request.query.get('q') || '').trim();
      if (!q) {
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accounts: [] })
        };
      }

      const pool = await getPool();
      const result = await pool.request()
        .input('q', sql.NVarChar, `%${q}%`)
        .query(`
          SELECT TOP 20
            account_id,
            [name] AS account_name,
            company_id
          FROM dbo.accounts
          WHERE [name] LIKE @q
          ORDER BY [name]
        `);

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: result.recordset })
      };
    } catch (error) {
      context.error('Account search error:', error);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message })
      };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/create-mapping
// Phase 1: Create a brand-new account AND its first subscription
// Blocks: duplicate account name, duplicate company_id,
//         duplicate subscription_guid
// ─────────────────────────────────────────────────────────────
app.http('create-mapping', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const body = await request.json();
      const { account_name, company_id, subscription_name, subscription_guid } = body || {};

      // ── Input validation ──
      const missing = [];
      if (!account_name?.trim())      missing.push('account_name');
      if (!company_id?.trim())        missing.push('company_id');
      if (!subscription_name?.trim()) missing.push('subscription_name');
      if (!subscription_guid?.trim()) missing.push('subscription_guid');

      if (missing.length) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Missing required fields: ${missing.join(', ')}` })
        };
      }

      if (!isValidGuid(subscription_guid.trim())) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'subscription_guid must be a valid GUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' })
        };
      }

      const acctName = account_name.trim();
      const compId   = company_id.trim();
      const subName  = subscription_name.trim();
      const subGuid  = subscription_guid.trim().toLowerCase();

      const pool = await getPool();

      // ── Duplicate checks ──
      const dupAcctName = await pool.request()
        .input('name', sql.NVarChar, acctName)
        .query(`SELECT account_id FROM dbo.accounts WHERE [name] = @name`);
      if (dupAcctName.recordset.length > 0) {
        return {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `An account named "${acctName}" already exists.` })
        };
      }

      const dupCompId = await pool.request()
        .input('company_id', sql.NVarChar, compId)
        .query(`SELECT account_id FROM dbo.accounts WHERE company_id = @company_id`);
      if (dupCompId.recordset.length > 0) {
        return {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Company ID "${compId}" is already assigned to another account.` })
        };
      }

      const dupGuid = await pool.request()
        .input('guid', sql.NVarChar, subGuid)
        .query(`SELECT subscription_id FROM dbo.subscriptions WHERE subscription_guid = @guid`);
      if (dupGuid.recordset.length > 0) {
        return {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Subscription GUID "${subGuid}" already exists.` })
        };
      }

      // ── Transactional insert ──
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        const insertAcct = await new sql.Request(transaction)
          .input('name',       sql.NVarChar, acctName)
          .input('company_id', sql.NVarChar, compId)
          .query(`
            INSERT INTO dbo.accounts ([name], company_id)
            VALUES (@name, @company_id);
            SELECT SCOPE_IDENTITY() AS account_id;
          `);

        const newAccountId = insertAcct.recordset[0].account_id;

        await new sql.Request(transaction)
          .input('account_id',        sql.Int,      newAccountId)
          .input('subscription_name', sql.NVarChar, subName)
          .input('subscription_guid', sql.NVarChar, subGuid)
          .query(`
            INSERT INTO dbo.subscriptions (account_id, subscription_name, subscription_guid)
            VALUES (@account_id, @subscription_name, @subscription_guid);
          `);

        await transaction.commit();

        return {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message:    'Account and subscription created successfully.',
            account_id: newAccountId,
            account_name: acctName,
            company_id:   compId,
            subscription_name: subName,
            subscription_guid: subGuid
          })
        };
      } catch (txErr) {
        await transaction.rollback();
        throw txErr;
      }
    } catch (error) {
      context.error('Create mapping error:', error);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Database error. Please try again.' })
      };
    }
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/add-subscription
// Phase 2: Add a subscription to an EXISTING account
// Requires: account_id (integer), subscription_name, subscription_guid
// Blocks: account not found, duplicate subscription_guid
// ─────────────────────────────────────────────────────────────
app.http('add-subscription', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const body = await request.json();
      const { account_id, subscription_name, subscription_guid } = body || {};

      // ── Input validation ──
      if (!account_id || isNaN(parseInt(account_id, 10))) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'A valid account_id is required.' })
        };
      }
      if (!subscription_name?.trim()) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'subscription_name is required.' })
        };
      }
      if (!subscription_guid?.trim()) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'subscription_guid is required.' })
        };
      }
      if (!isValidGuid(subscription_guid.trim())) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'subscription_guid must be a valid GUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' })
        };
      }

      const acctId  = parseInt(account_id, 10);
      const subName = subscription_name.trim();
      const subGuid = subscription_guid.trim().toLowerCase();

      const pool = await getPool();

      // ── Verify account exists ──
      const acctCheck = await pool.request()
        .input('account_id', sql.Int, acctId)
        .query(`
          SELECT account_id, [name] AS account_name
          FROM dbo.accounts
          WHERE account_id = @account_id
        `);
      if (!acctCheck.recordset.length) {
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Account with ID ${acctId} not found.` })
        };
      }

      // ── Block duplicate subscription_guid ──
      const dupGuid = await pool.request()
        .input('guid', sql.NVarChar, subGuid)
        .query(`SELECT subscription_id FROM dbo.subscriptions WHERE subscription_guid = @guid`);
      if (dupGuid.recordset.length > 0) {
        return {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Subscription GUID "${subGuid}" already exists in the database.` })
        };
      }

      // ── Insert ──
      const insertResult = await pool.request()
        .input('account_id',        sql.Int,      acctId)
        .input('subscription_name', sql.NVarChar, subName)
        .input('subscription_guid', sql.NVarChar, subGuid)
        .query(`
          INSERT INTO dbo.subscriptions (account_id, subscription_name, subscription_guid)
          VALUES (@account_id, @subscription_name, @subscription_guid);
          SELECT SCOPE_IDENTITY() AS subscription_id;
        `);

      const newSubId   = insertResult.recordset[0]?.subscription_id;
      const acctName   = acctCheck.recordset[0].account_name;

      return {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message:           'Subscription added successfully.',
          subscription_id:   newSubId,
          account_id:        acctId,
          account_name:      acctName,
          subscription_name: subName,
          subscription_guid: subGuid
        })
      };
    } catch (error) {
      context.error('Add subscription error:', error);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Database error. Please try again.' })
      };
    }
  }
});

app.setup({ enableHttpStream: true });
