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

app.setup({
  enableHttpStream: true
});