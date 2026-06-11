import { app } from '@azure/functions';
import sql from 'mssql';

// ─────────────────────────────────────────────────────────────
// Database connection pool (singleton with reset on failure)
// ─────────────────────────────────────────────────────────────
let pool = null;

const getPool = async () => {
    if (!pool) {
        const connStr = process.env.AzureSQLConnectionString;
        if (!connStr) {
            throw new Error('Missing AzureSQLConnectionString environment variable');
        }
        try {
            pool = await sql.connect(connStr);
        } catch (err) {
            pool = null; // Reset so the next request retries
            throw err;
        }
    }
    return pool;
};

// ─────────────────────────────────────────────────────────────
// Helper: parse pagination query params
// ─────────────────────────────────────────────────────────────
const getPagination = (request) => {
    const page     = Math.max(1, parseInt(request.query.get('page')      || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(request.query.get('page_size') || '50', 10)));
    const offset   = (page - 1) * pageSize;
    return { page, pageSize, offset };
};

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
//
// Returns all four dashboard card values:
//   total_accounts                  – COUNT(*) from dbo.accounts
//   total_subscriptions             – COUNT(*) from dbo.subscriptions
//   total_unknown                   – COUNT(*) from dbo.subscriptions_unknown
//   accounts_with_multiple_subscriptions – accounts that have >= 2 linked subscriptions
//
// FIX: The original query only returned total_accounts.
//      The frontend also reads total_subscriptions, total_unknown,
//      and accounts_with_multiple_subscriptions — all were undefined.
// ─────────────────────────────────────────────────────────────
app.http('summary', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const db = await getPool();
            const result = await db.request().query(`
                SELECT
                    (SELECT COUNT(*) FROM dbo.accounts)                          AS total_accounts,
                    (SELECT COUNT(*) FROM dbo.subscriptions)                     AS total_subscriptions,
                    (SELECT COUNT(*) FROM dbo.subscriptions_unknown)             AS total_unknown,
                    (
                        SELECT COUNT(*) FROM (
                            SELECT account_id
                            FROM dbo.subscriptions
                            GROUP BY account_id
                            HAVING COUNT(*) >= 2
                        ) multi
                    )                                                            AS accounts_with_multiple_subscriptions
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
// GET /api/accounts?page=1&page_size=50&search=
//
// Returns paginated list of accounts with subscription counts.
//
// FIX: Original query referenced a.account_name but the schema
//      column is actually `name` (nvarchar(255), not null).
//      All references to account_name updated to a.name AS account_name.
// ─────────────────────────────────────────────────────────────
app.http('accounts', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const db = await getPool();
            const { page, pageSize, offset } = getPagination(request);
            const search = request.query.get('search') || '';

            // Count query
            const countReq = db.request();
            let countQuery = `SELECT COUNT(*) AS total FROM dbo.accounts`;
            if (search) {
                countQuery += ` WHERE name LIKE @search`;
                countReq.input('search', sql.NVarChar, `%${search}%`);
            }
            const countResult = await countReq.query(countQuery);
            const total = countResult.recordset[0].total;

            // Data query
            const dataReq = db.request();
            dataReq.input('offset',   sql.Int, offset);
            dataReq.input('pageSize', sql.Int, pageSize);

            let dataQuery = `
                SELECT
                    a.account_id,
                    a.name         AS account_name,
                    a.company_id,
                    COUNT(s.subscription_id) AS subscription_count
                FROM dbo.accounts a
                LEFT JOIN dbo.subscriptions s ON a.account_id = s.account_id
            `;
            if (search) {
                dataQuery += ` WHERE a.name LIKE @search`;
                dataReq.input('search', sql.NVarChar, `%${search}%`);
            }
            dataQuery += `
                GROUP BY a.account_id, a.name, a.company_id
                ORDER BY a.name
                OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
            `;

            const dataResult = await dataReq.query(dataQuery);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    data: dataResult.recordset,
                    pagination: {
                        page,
                        page_size: pageSize,
                        total_records: total,
                        total_pages: Math.ceil(total / pageSize)
                    }
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
// GET /api/accounts/{accountId}
//
// Returns a single account and its linked subscriptions.
//
// FIX: Original query used `account_name` — the real column is `name`.
//      Updated SELECT and all references accordingly.
// ─────────────────────────────────────────────────────────────
app.http('account-detail', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'accounts/{accountId}',
    handler: async (request, context) => {
        try {
            const db        = await getPool();
            const accountId = request.params.accountId;

            // Validate accountId is numeric to prevent injection
            if (!accountId || isNaN(Number(accountId))) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Invalid accountId' })
                };
            }

            // Get account — column is `name`, aliased as account_name for frontend compatibility
            const accountResult = await db.request()
                .input('accountId', sql.Int, accountId)
                .query(`
                    SELECT account_id,
                           name       AS account_name,
                           company_id
                    FROM dbo.accounts
                    WHERE account_id = @accountId
                `);

            if (accountResult.recordset.length === 0) {
                return {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Account not found' })
                };
            }

            // Get subscriptions for this account
            // subscription_guid is nullable (uniqueidentifier, null) — handled gracefully
            const subsResult = await db.request()
                .input('accountId', sql.Int, accountId)
                .query(`
                    SELECT subscription_id,
                           subscription_name,
                           subscription_guid
                    FROM dbo.subscriptions
                    WHERE account_id = @accountId
                    ORDER BY subscription_name
                `);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account:       accountResult.recordset[0],
                    subscriptions: subsResult.recordset
                })
            };
        } catch (error) {
            context.error('Account detail error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: error.message })
            };
        }
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/subscriptions?page=1&page_size=50&search=
//
// Returns paginated list from dbo.subscriptions joined to dbo.accounts.
//
// FIX: Original query referenced a.account_name — real column is a.name.
//      Also referenced only subscription_id/account_id in the original
//      stub; now returns all columns the frontend table expects.
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

            // Count
            const countReq = db.request();
            let countQuery = `
                SELECT COUNT(*) AS total
                FROM dbo.subscriptions s
                LEFT JOIN dbo.accounts a ON s.account_id = a.account_id
            `;
            if (search) {
                countQuery += ` WHERE (s.subscription_name LIKE @search OR a.name LIKE @search)`;
                countReq.input('search', sql.NVarChar, `%${search}%`);
            }
            const countResult = await countReq.query(countQuery);

            // Data — account_name alias for frontend compatibility
            const dataReq = db.request();
            dataReq.input('offset',   sql.Int, offset);
            dataReq.input('pageSize', sql.Int, pageSize);

            let dataQuery = `
                SELECT
                    s.subscription_id,
                    s.subscription_name,
                    s.subscription_guid,
                    s.account_id,
                    a.name       AS account_name,
                    a.company_id
                FROM dbo.subscriptions s
                LEFT JOIN dbo.accounts a ON s.account_id = a.account_id
            `;
            if (search) {
                dataQuery += ` WHERE (s.subscription_name LIKE @search OR a.name LIKE @search)`;
                dataReq.input('search', sql.NVarChar, `%${search}%`);
            }
            dataQuery += `
                ORDER BY s.subscription_name
                OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
            `;

            const dataResult = await dataReq.query(dataQuery);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    data: dataResult.recordset,
                    pagination: {
                        page,
                        page_size: pageSize,
                        total_records: countResult.recordset[0].total,
                        total_pages: Math.ceil(countResult.recordset[0].total / pageSize)
                    }
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
// GET /api/unknown?page=1&page_size=50
//
// Returns paginated list from dbo.subscriptions_unknown.
//
// FIX: Original query looked at dbo.subscriptions WHERE guid IS NULL —
//      but your schema has a separate dbo.subscriptions_unknown table.
//      PK is `id` (not subscription_id). Updated accordingly.
// ─────────────────────────────────────────────────────────────
app.http('unknown', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const db = await getPool();
            const { page, pageSize, offset } = getPagination(request);

            const countResult = await db.request().query(`
                SELECT COUNT(*) AS total FROM dbo.subscriptions_unknown
            `);

            const dataResult = await db.request()
                .input('offset',   sql.Int, offset)
                .input('pageSize', sql.Int, pageSize)
                .query(`
                    SELECT
                        id,
                        subscription_name,
                        subscription_guid
                    FROM dbo.subscriptions_unknown
                    ORDER BY subscription_name
                    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
                `);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    data: dataResult.recordset,
                    pagination: {
                        page,
                        page_size: pageSize,
                        total_records: countResult.recordset[0].total,
                        total_pages: Math.ceil(countResult.recordset[0].total / pageSize)
                    }
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

app.setup({ enableHttpStream: true });
