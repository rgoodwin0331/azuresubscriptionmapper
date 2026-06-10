import { app } from '@azure/functions';
import sql from 'mssql';

// Database connection string from environment
const getConnectionString = () => {
  return process.env.AzureSQLConnectionString;
};

// Initialize database pool
let pool = null;
const getPool = async () => {
  if (!pool) {
    const connStr = getConnectionString();
    if (!connStr) {
      throw new Error('Missing AzureSQLConnectionString environment variable');
    }
    pool = await sql.connect(connStr);
  }
  return pool;
};

// Health check endpoint
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

// Summary endpoint
app.http('summary', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT COUNT(*) AS total_accounts 
        FROM Accounts
      `);
      
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          total_accounts: result.recordset[0].total_accounts
        })
      };
    } catch (error) {
      context.error('DB Error:', error);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message })
      };
    }
  }
});

// Subscriptions endpoint
app.http('subscriptions', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT TOP 50 subscription_id, account_id 
        FROM Subscriptions
      `);
      
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.recordset)
      };
    } catch (error) {
      context.error('DB Error:', error);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message })
      };
    }
  }
});

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

app.setup({
  enableHttpStream: true
});