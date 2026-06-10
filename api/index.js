const sql = require('mssql');

module.exports = async function (context, req) {
  const route = req.params.route || '';
  
  try {
    const connStr = process.env.AzureSQLConnectionString;
    if (!connStr) {
      context.res = { status: 500, body: { error: 'Missing AzureSQLConnectionString' } };
      return;
    }
    
    const pool = await sql.connect(connStr);
    
    if (route === 'health') {
      context.res = { status: 200, body: 'API is running' };
    } else if (route === 'summary') {
      const result = await pool.request().query(`
        SELECT COUNT(*) AS total_accounts FROM Accounts
      `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: { total_accounts: result.recordset[0].total_accounts }
      };
    } else if (route === 'subscriptions') {
      const result = await pool.request().query(`
        SELECT TOP 50 subscription_id, account_id FROM Subscriptions
      `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: result.recordset
      };
    } else {
      context.res = { status: 404, body: 'Not found' };
    }
    
    await sql.close();
  } catch (err) {
    context.log.error('DB Error:', err);
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: { error: err.message }
    };
  }
};