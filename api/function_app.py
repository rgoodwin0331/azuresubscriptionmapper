"""
Azure Function API for Account-Subscription Mapping
"""
import azure.functions as func
import os
import json

# Try to import pyodbc, but handle if it's not available
try:
    import pyodbc
    PYODBC_AVAILABLE = True
except ImportError:
    PYODBC_AVAILABLE = False

app = func.FunctionApp(http_auth_level=func.HttpAuthLevel.ANONYMOUS)

def get_connection_string():
    """Get database connection string from environment"""
    conn_str = os.environ.get("AzureSQLConnectionString")
    if not conn_str:
        # Try alternative names
        conn_str = os.environ.get("DATABASE_CONNECTION_STRING")
    if not conn_str:
        conn_str = os.environ.get("SQL_CONNECTION_STRING")
    return conn_str

def get_db_connection():
    """Create database connection"""
    if not PYODBC_AVAILABLE:
        raise Exception("pyodbc module is not installed. Check requirements.txt")
    
    conn_str = get_connection_string()
    if not conn_str:
        raise Exception("Database connection string not configured. Set AzureSQLConnectionString environment variable.")
    
    try:
        conn = pyodbc.connect(conn_str)
        return conn
    except Exception as e:
        raise Exception(f"Failed to connect to database: {str(e)}")

@app.route(route="summary", auth_level=func.HttpAuthLevel.ANONYMOUS)
def get_summary(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/summary - Returns summary statistics"""
    try:
        conn_str = get_connection_string()
        if not conn_str:
            return func.HttpResponse(
                json.dumps({"error": "Database connection string not configured", "hint": "Set AzureSQLConnectionString environment variable"}),
                mimetype="application/json",
                status_code=500
            )
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Total accounts
        cursor.execute("SELECT COUNT(*) FROM accounts")
        total_accounts = cursor.fetchone()[0]
        
        # Total subscriptions
        cursor.execute("SELECT COUNT(*) FROM subscriptions")
        total_subscriptions = cursor.fetchone()[0]
        
        # Unknown subscriptions
        cursor.execute("SELECT COUNT(*) FROM subscriptions_unknown")
        total_unknown = cursor.fetchone()[0]
        
        # Accounts with multiple subscriptions
        cursor.execute("""
            SELECT COUNT(*) FROM (
                SELECT account_id FROM subscriptions
                GROUP BY account_id
                HAVING COUNT(*) > 1
            ) AS multi
        """)
        accounts_with_multi = cursor.fetchone()[0]
        
        cursor.close()
        conn.close()
        
        result = {
            "total_accounts": total_accounts,
            "total_subscriptions": total_subscriptions,
            "total_unknown": total_unknown,
            "accounts_with_multiple_subscriptions": accounts_with_multi
        }
        
        return func.HttpResponse(
            json.dumps(result),
            mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"}
        )
        
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"}
        )

@app.route(route="accounts", auth_level=func.HttpAuthLevel.ANONYMOUS)
def get_accounts(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/accounts - List all accounts"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get query parameters
        search = req.params.get("search", "")
        
        if search:
            query = """
                SELECT a.account_id, a.name AS account_name, a.company_id,
                       COUNT(s.subscription_id) AS subscription_count
                FROM accounts a
                LEFT JOIN subscriptions s ON a.account_id = s.account_id
                WHERE a.name LIKE ? OR a.company_id LIKE ?
                GROUP BY a.account_id, a.name, a.company_id
                ORDER BY a.name
            """
            cursor.execute(query, (f"%{search}%", f"%{search}%"))
        else:
            query = """
                SELECT a.account_id, a.name AS account_name, a.company_id,
                       COUNT(s.subscription_id) AS subscription_count
                FROM accounts a
                LEFT JOIN subscriptions s ON a.account_id = s.account_id
                GROUP BY a.account_id, a.name, a.company_id
                ORDER BY a.name
            """
            cursor.execute(query)
        
        columns = [column[0] for column in cursor.description]
        results = []
        
        for row in cursor.fetchall():
            results.append(dict(zip(columns, row)))
        
        cursor.close()
        conn.close()
        
        return func.HttpResponse(
            json.dumps({"data": results, "pagination": {"total": len(results)}}),
            mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"}
        )
        
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"}
        )

@app.route(route="accounts/{account_id}", auth_level=func.HttpAuthLevel.ANONYMOUS)
def get_account_detail(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/accounts/{account_id} - Get account details"""
    try:
        account_id = req.route_params.get("account_id")
        
        if not account_id:
            return func.HttpResponse(
                json.dumps({"error": "account_id is required"}),
                mimetype="application/json",
                status_code=400
            )
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get account info
        cursor.execute("""
            SELECT account_id, name AS account_name, company_id
            FROM accounts WHERE account_id = ?
        """, (int(account_id),))
        
        columns = [column[0] for column in cursor.description]
        accounts = []
        for row in cursor.fetchall():
            accounts.append(dict(zip(columns, row)))
        
        if not accounts:
            return func.HttpResponse(
                json.dumps({"error": "Account not found"}),
                mimetype="application/json",
                status_code=404
            )
        
        # Get subscriptions for this account
        cursor.execute("""
            SELECT subscription_id, subscription_name, subscription_guid
            FROM subscriptions WHERE account_id = ?
            ORDER BY subscription_name
        """, (int(account_id),))
        
        columns = [column[0] for column in cursor.description]
        subscriptions = []
        for row in cursor.fetchall():
            subscriptions.append(dict(zip(columns, row)))
        
        cursor.close()
        conn.close()
        
        result = {
            "account": accounts[0],
            "subscriptions": subscriptions
        }
        
        return func.HttpResponse(
            json.dumps(result),
            mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"}
        )
        
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"}
        )

@app.route(route="subscriptions", auth_level=func.HttpAuthLevel.ANONYMOUS)
def get_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/subscriptions - List all subscriptions"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        search = req.params.get("search", "")
        
        if search:
            query = """
                SELECT s.subscription_id, s.subscription_name, s.subscription_guid,
                       a.account_id, a.name AS account_name, a.company_id
                FROM subscriptions s
                JOIN accounts a ON s.account_id = a.account_id
                WHERE s.subscription_name LIKE ? OR a.name LIKE ?
                ORDER BY s.subscription_name
            """
            cursor.execute(query, (f"%{search}%", f"%{search}%"))
        else:
            query = """
                SELECT s.subscription_id, s.subscription_name, s.subscription_guid,
                       a.account_id, a.name AS account_name, a.company_id
                FROM subscriptions s
                JOIN accounts a ON s.account_id = a.account_id
                ORDER BY s.subscription_name
            """
            cursor.execute(query)
        
        columns = [column[0] for column in cursor.description]
        results = []
        for row in cursor.fetchall():
            results.append(dict(zip(columns, row)))
        
        cursor.close()
        conn.close()
        
        return func.HttpResponse(
            json.dumps({"data": results, "pagination": {"total": len(results)}}),
            mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"}
        )
        
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"}
        )

@app.route(route="unknown", auth_level=func.HttpAuthLevel.ANONYMOUS)
def get_unknown_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/unknown - List unmapped subscriptions"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT id, subscription_name, subscription_guid
            FROM subscriptions_unknown
            ORDER BY subscription_name
        """)
        
        columns = [column[0] for column in cursor.description]
        results = []
        for row in cursor.fetchall():
            results.append(dict(zip(columns, row)))
        
        cursor.close()
        conn.close()
        
        return func.HttpResponse(
            json.dumps({"data": results}),
            mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"}
        )
        
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"}
        )

