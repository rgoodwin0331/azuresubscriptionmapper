"""
Azure Function API for Account-Subscription Mapping
Python v2 programming model for Azure Static Web Apps
"""
import azure.functions as func
import os
import json
import pyodbc
from typing import List, Dict, Any

app = func.FunctionApp(http_auth_level=func.HttpAuthLevel.ANONYMOUS)

def get_db_connection():
    """Get database connection string from environment"""
    conn_str = os.environ.get("AzureSQLConnectionString")
    if not conn_str:
        # Fallback for local development
        conn_str = (
            "Driver={ODBC Driver 18 for SQL Server};"
            "Server=tcp:your-server.database.windows.net,1433;"
            "Database=accountmapping;"
            "Authentication=ActiveDirectoryManagedIdentity;"
            "Encrypt=yes;"
            "TrustServerCertificate=no;"
        )
    return conn_str

def execute_query(query: str, params: tuple = None) -> List[Dict[str, Any]]:
    """Execute query and return results as list of dictionaries"""
    conn = pyodbc.connect(get_db_connection())
    cursor = conn.cursor()
    
    if params:
        cursor.execute(query, params)
    else:
        cursor.execute(query)
    
    columns = [column[0] for column in cursor.description]
    results = []
    
    for row in cursor.fetchall():
        row_dict = {}
        for i, col in enumerate(columns):
            value = row[i]
            # Convert non-JSON-serializable types
            if hasattr(value, 'isoformat'):
                value = value.isoformat()
            row_dict[col] = value
        results.append(row_dict)
    
    cursor.close()
    conn.close()
    return results

def create_json_response(data: any, status_code: int = 200) -> func.HttpResponse:
    """Create a JSON response with CORS headers"""
    return func.HttpResponse(
        json.dumps(data, default=str),
        mimetype="application/json",
        status_code=status_code,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "*"
        }
    )

@app.route(route="accounts", methods=[func.HttpMethod.GET])
def get_accounts(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/accounts
    Returns all accounts with their subscription counts
    Query params: search, page, page_size
    """
    try:
        search = req.params.get("search", "")
        page = int(req.params.get("page", 1))
        page_size = int(req.params.get("page_size", 50))
        
        offset = (page - 1) * page_size
        
        # Build query with pagination
        if search:
            query = """
                SELECT 
                    a.account_id,
                    a.name AS account_name,
                    a.company_id,
                    COUNT(s.subscription_id) AS subscription_count
                FROM accounts a
                LEFT JOIN subscriptions s ON a.account_id = s.account_id
                WHERE a.name LIKE ? OR a.company_id LIKE ?
                GROUP BY a.account_id, a.name, a.company_id
                ORDER BY a.name
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
            """
            count_query = """
                SELECT COUNT(*) as total FROM accounts
                WHERE name LIKE ? OR company_id LIKE ?
            """
            search_param = f"%{search}%"
            results = execute_query(query, (search_param, search_param, offset, page_size))
            count_result = execute_query(count_query, (search_param, search_param))
            total = count_result[0]['total'] if count_result else 0
        else:
            query = """
                SELECT 
                    a.account_id,
                    a.name AS account_name,
                    a.company_id,
                    COUNT(s.subscription_id) AS subscription_count
                FROM accounts a
                LEFT JOIN subscriptions s ON a.account_id = s.account_id
                GROUP BY a.account_id, a.name, a.company_id
                ORDER BY a.name
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
            """
            count_query = "SELECT COUNT(*) as total FROM accounts"
            results = execute_query(query, (offset, page_size))
            count_result = execute_query(count_query)
            total = count_result[0]['total'] if count_result else 0
        
        total_pages = (total + page_size - 1) // page_size
        
        return create_json_response({
            "data": results,
            "pagination": {
                "page": page,
                "page_size": page_size,
                "total": total,
                "total_pages": total_pages
            }
        })
        
    except Exception as e:
        return create_json_response({"error": str(e)}, 500)

@app.route(route="accounts/{account_id}", methods=[func.HttpMethod.GET])
def get_account_detail(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/accounts/{account_id}
    Returns account details with all subscriptions
    """
    try:
        account_id = req.route_params.get("account_id")
        
        if not account_id:
            return create_json_response({"error": "account_id is required"}, 400)
        
        account_query = """
            SELECT account_id, name AS account_name, company_id
            FROM accounts
            WHERE account_id = ?
        """
        accounts = execute_query(account_query, (int(account_id),))
        
        if not accounts:
            return create_json_response({"error": "Account not found"}, 404)
        
        subs_query = """
            SELECT 
                subscription_id,
                subscription_name,
                subscription_guid
            FROM subscriptions
            WHERE account_id = ?
            ORDER BY subscription_name
        """
        subscriptions = execute_query(subs_query, (int(account_id),))
        
        return create_json_response({
            "account": accounts[0],
            "subscriptions": subscriptions
        })
        
    except Exception as e:
        return create_json_response({"error": str(e)}, 500)

@app.route(route="subscriptions", methods=[func.HttpMethod.GET])
def get_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/subscriptions
    Returns all subscriptions with optional filtering
    Query params: account_id, search, page, page_size
    """
    try:
        account_id = req.params.get("account_id")
        search = req.params.get("search", "")
        page = int(req.params.get("page", 1))
        page_size = int(req.params.get("page_size", 50))
        
        offset = (page - 1) * page_size
        
        # Build query
        query = """
            SELECT 
                s.subscription_id,
                s.subscription_name,
                s.subscription_guid,
                a.account_id,
                a.name AS account_name,
                a.company_id
            FROM subscriptions s
            JOIN accounts a ON s.account_id = a.account_id
            WHERE 1=1
        """
        params = []
        
        if account_id:
            query += " AND s.account_id = ?"
            params.append(int(account_id))
        
        if search:
            query += " AND (s.subscription_name LIKE ? OR a.name LIKE ?)"
            params.extend([f"%{search}%", f"%{search}%"])
        
        # Get total count
        count_query = f"SELECT COUNT(*) as total FROM ({query}) as subq"
        count_result = execute_query(count_query, tuple(params) if params else None)
        total = count_result[0]['total'] if count_result else 0
        
        # Add pagination
        query += " ORDER BY s.subscription_name OFFSET ? ROWS FETCH NEXT ? ROWS ONLY"
        params.extend([offset, page_size])
        
        results = execute_query(query, tuple(params))
        
        total_pages = (total + page_size - 1) // page_size
        
        return create_json_response({
            "data": results,
            "pagination": {
                "page": page,
                "page_size": page_size,
                "total": total,
                "total_pages": total_pages
            }
        })
        
    except Exception as e:
        return create_json_response({"error": str(e)}, 500)

@app.route(route="unknown", methods=[func.HttpMethod.GET])
def get_unknown_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/unknown
    Returns subscriptions that couldn't be mapped
    """
    try:
        query = """
            SELECT id, subscription_name, subscription_guid 
            FROM subscriptions_unknown 
            ORDER BY subscription_name
        """
        results = execute_query(query)
        
        return create_json_response({"data": results})
        
    except Exception as e:
        return create_json_response({"error": str(e)}, 500)

@app.route(route="summary", methods=[func.HttpMethod.GET])
def get_summary(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/summary
    Returns summary statistics
    """
    try:
        total_accounts = execute_query("SELECT COUNT(*) as count FROM accounts")
        total_subscriptions = execute_query("SELECT COUNT(*) as count FROM subscriptions")
        total_unknown = execute_query("SELECT COUNT(*) as count FROM subscriptions_unknown")
        accounts_multi = execute_query("""
            SELECT COUNT(*) as count FROM (
                SELECT account_id FROM subscriptions
                GROUP BY account_id
                HAVING COUNT(*) > 1
            ) AS multi
        """)
        
        result = {
            "total_accounts": total_accounts[0]['count'] if total_accounts else 0,
            "total_subscriptions": total_subscriptions[0]['count'] if total_subscriptions else 0,
            "total_unknown": total_unknown[0]['count'] if total_unknown else 0,
            "accounts_with_multiple_subscriptions": accounts_multi[0]['count'] if accounts_multi else 0
        }
        
        return create_json_response(result)
        
    except Exception as e:
        return create_json_response({"error": str(e)}, 500)
