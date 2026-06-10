import { app } from '@azure/functions';
import sql from 'mssql';

// Database connection
let pool = null;
const getPool = async () => {
  if (!pool) {
    const connStr = process.env.AzureSQLConnectionString;
    if (!connStr) {
      throw new Error('Missing AzureSQLConnectionString');
    }
    pool = await sql.connect(connStr);
  }
  return pool;
};

// Helper: parse pagination params
const getPagination = (req) => {
  const page = parseInt(req.query.get('page') || '1', 10);
  const pageSize = parseInt(req.query.get('page_size') || '50', 10);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
};

// Health check
app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    return { status: 200, body: 'OK' };
  }
});

// Summary endpoint - MUST match what frontend expects
app.http('summary', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      
      // Get total accounts
      const accountsResult = await pool.request().query(`
        SELECT COUNT(*) AS count FROM Accounts
      `);
      
      // Get total subscriptions (mapped)
      const subscriptionsResult = await pool.request().query(`
        SELECT COUNT(*) AS count FROM Subscriptions WHERE subscription_guid IS NOT NULL
      `);
      
      // Get unknown subscriptions (no GUID)
      const unknownResult = await pool.request().query(`
        SELECT COUNT(*) AS count FROM Subscriptions WHERE subscription_guid IS NULL OR subscription_guid = ''
      `);
      
      // Get accounts with 2+ subscriptions
      const multiResult = await pool.request().query(`
        SELECT COUNT(*) AS count FROM (
          SELECT account_id FROM Subscriptions 
          WHERE account_id IS NOT NULL 
          GROUP BY account_id 
          HAVING COUNT(*) >= 2
        ) AS multi_accounts
      `);
      
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          total_accounts: accountsResult.recordset[0].count,
          total_subscriptions: subscriptionsResult.recordset[0].count,
          total_unknown: unknownResult.recordset[0].count,
          accounts_with_multiple_subscriptions: multiResult.recordset[0].count
        })
      };
    } catch (error) {
      context.log.error('Summary error:', error);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message })
      };
    }
  }
});

// Accounts list endpoint (with pagination & search)
app.http('accounts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const { page, pageSize, offset } = getPagination(request);
      const search = request.query.get('search') || '';
      
      // Count query
      let countQuery = 'SELECT COUNT(*) AS total FROM Accounts';
      let dataQuery = `
        SELECT a.account_id, a.account_name, a.company_id, 
               COUNT(s.subscription_id) AS subscription_count
        FROM Accounts a
        LEFT JOIN Subscriptions s ON a.account_id = s.account_id
      `;
      
      const conditions = [];
      const params = [];
      
      if (search) {
        conditions.push('a.account_name LIKE @search');
        params.push({ name: 'search', value: `%${search}%` });
      }
      
      if (conditions.length > 0) {
        countQuery += ' WHERE ' + conditions.map(c => c.replace('a.', '')).join(' AND ');
        dataQuery += ' WHERE ' + conditions.join(' AND ');
      }
      
      dataQuery += ' GROUP BY a.account_id, a.account_name, a.company_id ORDER BY a.account_name OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY';
      
      // Get total count
      const countReq = pool.request();
      params.forEach(p => countReq.input(p.name, p.value));
      const countResult = await countReq.query(countQuery);
      const total = countResult.recordset[0].total;
      
      // Get data
      const dataReq = pool.request();
      dataReq.input('offset', offset);
      dataReq.input('pageSize', pageSize);
      params.forEach(p => dataReq.input(p.name, p.value));
      const dataResult = await dataReq.query(dataQuery);
      
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: dataResult.recordset,
          pagination: { page, page_size: pageSize, total_pages: Math.ceil(total / pageSize) }
        })
      };
    } catch (error) {
      context.log.error('Accounts error:', error);
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: error.message }) };
    }
  }
});

// Account detail endpoint
app.http('account-detail', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'accounts/{accountId}',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const accountId = request.params.accountId;
      
      // Get account
      const accountResult = await pool.request()
        .input('accountId', accountId)
        .query('SELECT account_id, account_name, company_id FROM Accounts WHERE account_id = @accountId');
      
      if (accountResult.recordset.length === 0) {
        return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Account not found' }) };
      }
      
      // Get subscriptions
      const subsResult = await pool.request()
        .input('accountId', accountId)
        .query('SELECT subscription_id, subscription_name, subscription_guid FROM Subscriptions WHERE account_id = @accountId');
      
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: accountResult.recordset[0],
          subscriptions: subsResult.recordset
        })
      };
    } catch (error) {
      context.log.error('Account detail error:', error);
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: error.message }) };
    }
  }
});

// Subscriptions list endpoint
app.http('subscriptions-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'subscriptions',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const { page, pageSize, offset } = getPagination(request);
      const search = request.query.get('search') || '';
      
      let countQuery = 'SELECT COUNT(*) AS total FROM Subscriptions s LEFT JOIN Accounts a ON s.account_id = a.account_id';
      let dataQuery = `
        SELECT s.subscription_id, s.subscription_name, s.subscription_guid,
               a.account_name, a.company_id
        FROM Subscriptions s
        LEFT JOIN Accounts a ON s.account_id = a.account_id
      `;
      
      const conditions = [];
      if (search) {
        conditions.push('(s.subscription_name LIKE @search OR a.account_name LIKE @search)');
      }
      
      if (conditions.length > 0) {
        countQuery += ' WHERE ' + conditions.join(' AND ');
        dataQuery += ' WHERE ' + conditions.join(' AND ');
      }
      
      dataQuery += ' ORDER BY s.subscription_name OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY';
      
      const countReq = pool.request();
      if (search) countReq.input('search', `%${search}%`);
      const countResult = await countReq.query(countQuery);
      
      const dataReq = pool.request();
      dataReq.input('offset', offset);
      dataReq.input('pageSize', pageSize);
      if (search) dataReq.input('search', `%${search}%`);
      const dataResult = await dataReq.query(dataQuery);
      
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: dataResult.recordset,
          pagination: { page, page_size: pageSize, total_pages: Math.ceil(countResult.recordset[0].total / pageSize) }
        })
      };
    } catch (error) {
      context.log.error('Subscriptions error:', error);
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: error.message }) };
    }
  }
});

// Unknown subscriptions endpoint
app.http('unknown', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const { page, pageSize, offset } = getPagination(request);
      
      const countResult = await pool.request().query(`
        SELECT COUNT(*) AS total FROM Subscriptions 
        WHERE subscription_guid IS NULL OR subscription_guid = ''
      `);
      
      const dataResult = await pool.request()
        .input('offset', offset)
        .input('pageSize', pageSize)
        .query(`
          SELECT subscription_id, subscription_name, subscription_guid
          FROM Subscriptions
          WHERE subscription_guid IS NULL OR subscription_guid = ''
          ORDER BY subscription_name
          OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);
      
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: dataResult.recordset,
          pagination: { page, page_size: pageSize, total_pages: Math.ceil(countResult.recordset[0].total / pageSize) }
        })
      };
    } catch (error) {
      context.log.error('Unknown error:', error);
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: error.message }) };
    }
  }
});