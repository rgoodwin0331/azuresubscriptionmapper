"""
Azure Function API for Account-Subscription Mapping
Python v2 model - properly handles startup errors
"""
import azure.functions as func
import os
import json
import logging

# Initialize the Function App
app = func.FunctionApp()

# Get connection string at module level, but don't fail if not available
_connection_string = os.environ.get("AzureSQLConnectionString", "")

def get_db_connection_string():
    """Get database connection string from environment"""
    conn_str = os.environ.get("AzureSQLConnectionString")
    if not conn_str:
        logging.error("AzureSQLConnectionString environment variable not set")
        return None
    return conn_str

def safe_query_db(query: str, params: tuple = None):
    """
    Execute query and return results as list of dictionaries.
    Returns None on error.
    """
    try:
        import pyodbc
        
        conn_str = get_db_connection_string()
        if not conn_str:
            return None, "Database connection string not configured"
        
        conn = pyodbc.connect(conn_str)
        cursor = conn.cursor()
        
        if params:
            cursor.execute(query, params)
        else:
            cursor.execute(query)
        
        # Check if this is a SELECT query
        if cursor.description:
            columns = [column[0] for column in cursor.description]
            results = []
            
            for row in cursor.fetchall():
                # Convert row to dict, handling special types
                row_dict = {}
                for i, col in enumerate(columns):
                    val = row[i]
                    # Handle bytes (like GUIDs)
                    if isinstance(val, bytes):
                        # Try to decode as string or convert to hex
                        try:
                            val = val.decode('utf-8')
                        except:
                            val = val.hex() if val else None
                    row_dict[col] = val
                results.append(row_dict)
            
            cursor.close()
            conn.close()
            return results, None
        else:
            cursor.close()
            conn.close()
            return [], None
            
    except Exception as e:
        logging.error(f"Database error: {str(e)}")
        return None, str(e)

# ============================================================
# API ENDPOINTS
# ============================================================

@app.route(route="summary", auth_level=func.AuthLevel.ANONYMOUS)
def get_summary(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/summary
    Returns summary statistics
    """
    logging.info("Summary endpoint called")
    
    try:
        # Query for total accounts
        accounts_query = "SELECT COUNT(*) as count FROM accounts"
        accounts_result, accounts_error = safe_query_db(accounts_query)
        
        if accounts_error:
            return func.HttpResponse(
                json.dumps({"error": accounts_error}),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        # Query for total subscriptions
        subs_query = "SELECT COUNT(*) as count FROM subscriptions"
        subs_result, subs_error = safe_query_db(subs_query)
        
        if subs_error:
            return func.HttpResponse(
                json.dumps({"error": subs_error}),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        # Query for unknown subscriptions
        unknown_query = "SELECT COUNT(*) as count FROM subscriptions_unknown"
        unknown_result, unknown_error = safe_query_db(unknown_query)
        
        if unknown_error:
            return func.HttpResponse(
                json.dumps({"error": unknown_error}),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        # Query for accounts with multiple subscriptions
        multi_query = """
            SELECT COUNT(*) as count FROM (
                SELECT account_id FROM subscriptions
                GROUP BY account_id
                HAVING COUNT(*) > 1
            ) AS multi
        """
        multi_result, multi_error = safe_query_db(multi_query)
        
        if multi_error:
            return func.HttpResponse(
                json.dumps({"error": multi_error}),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        result = {
            "total_accounts": accounts_result[0]["count"] if accounts_result else 0,
            "total_subscriptions": subs_result[0]["count"] if subs_result else 0,
            "total_unknown": unknown_result[0]["count"] if unknown_result else 0,
            "accounts_with_multiple_subscriptions": multi_result[0]["count"] if multi_result else 0
        }
        
        return func.HttpResponse(
            json.dumps(result),
            mimetype="application/json",
            status_code=200,
            headers={"Access-Control-Allow-Origin": "*"}
        )
        
    except Exception as e:
        logging.error(f"Summary endpoint error: {str(e)}")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"}
        )

@app.route(route="accounts", auth_level=func.AuthLevel.ANONYMOUS)
def get_accounts(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/accounts
    Returns all accounts with subscription counts
    Query params: search, page, page_size
    """
    logging.info("Accounts endpoint called")
    
    try:
        search = req.params.get("search", "")
        page = int(req.params.get("page", 1))
        page_size = int(req.params.get("page_size", 50))
        
        # Calculate offset
        offset = (page - 1) * page_size
        
        # Build query
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
            params = (f"%{search}%", f"%{search}%", offset, page_size)
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
            params = (offset, page_size)
        
        results, error = safe_query_db(query, params)
        
        if error:
            return func.HttpResponse(
                json.dumps({"error": error}),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        # Get total count for pagination
        if search:
            count_query = "SELECT COUNT(*) as count FROM accounts WHERE name LIKE ? OR company_id LIKE ?"
            count_params = (f"%{search}%", f"%{search}%")
        else:
            count_query = "SELECT COUNT(*) as count FROM accounts"
            count_params = None
        
        count_result, count_error = safe_query_db(count_query, count_params)
        
        if count_error:
            return func.HttpResponse(
                json.dumps({"error": count_error}),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        total = count_result[0]["count"] if count_result else 0
        total_pages = (total + page_size - 1) // page_size if total > 0 else 1
        
        response_data = {
            "data": results or [],
            "pagination": {
                "page": page,
                "page_size": page_size,
                "total": total,
                "total_pages": total_pages
            }
        }
        
        return func.HttpResponse(
            json.dumps(response_data),
            mimetype="application/json",
            status_code=200,
            headers={"Access-Control-Allow-Origin": "*"}
        )
        
    except Exception as e:
        logging.error(f"Accounts endpoint error: {str(e)}")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"}
        )

@app.route(route="accounts/{account_id}", auth_level=func.AuthLevel.ANONYMOUS)
def get_account_detail(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/accounts/{account_id}
    Returns account details with its subscriptions
    """
    logging.info("Account detail endpoint called")
    
    try:
        account_id = req.route_params.get("account_id")
        
        if not account_id:
            return func.HttpResponse(
                json.dumps({"error": "account_id is required"}),
                mimetype="application/json",
                status_code=400,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        # Get account info
        account_query = """
            SELECT account_id, name AS account_name, company_id
            FROM accounts
            WHERE account_id = ?
        """
        accounts, account_error = safe_query_db(account_query, (account_id,))
        
        if account_error:
            return func.HttpResponse(
                json.dumps({"error": account_error}),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        if not accounts:
            return func.HttpResponse(
                json.dumps({"error": "Account not found"}),
                mimetype="application/json",
                status_code=404,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        # Get subscriptions for this account
        subs_query = """
            SELECT 
                subscription_id,
                subscription_name,
                subscription_guid
            FROM subscriptions
            WHERE account_id = ?
            ORDER BY subscription_name
        """
        subscriptions, subs_error = safe_query_db(subs_query, (account_id,))
        
        if subs_error:
            return func.HttpResponse(
                json.dumps({"error": subs_error}),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        result = {
            "account": accounts[0],
            "subscriptions": subscriptions or []
        }
        
        return func.HttpResponse(
            json.dumps(result),
            mimetype="application/json",
            status_code=200,
            headers={"Access-Control-Allow-Origin": "*"}
        )
        
    except Exception as e:
        logging.error(f"Account detail endpoint error: {str(e)}")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"}
        )

@app.route(route="subscriptions", auth_level=func.AuthLevel.ANONYMOUS)
def get_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/subscriptions
    Returns all subscriptions with optional filtering
    Query params: account_id, search, page, page_size
    """
    logging.info("Subscriptions endpoint called")
    
    try:
        account_id = req.params.get("account_id")
        search = req.params.get("search", "")
        page = int(req.params.get("page", 1))
        page_size = int(req.params.get("page_size", 50))
        
        offset = (page - 1) * page_size
        
        # Build base query
        query_parts = ["""
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
        """]
        params = []
        
        if account_id:
            query_parts.append(" AND s.account_id = ?")
            params.append(account_id)
        
        if search:
            query_parts.append(" AND (s.subscription_name LIKE ? OR a.name LIKE ?)")
            params.extend([f"%{search}%", f"%{search}%"])
        
        query_parts.append(" ORDER BY s.subscription_name OFFSET ? ROWS FETCH NEXT ? ROWS ONLY")
        params.extend([offset, page_size])
        
        query = "".join(query_parts)
        results, error = safe_query_db(query, tuple(params))
        
        if error:
            return func.HttpResponse(
                json.dumps({"error": error}),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        # Get total count
        count_parts = ["SELECT COUNT(*) as count FROM subscriptions s JOIN accounts a ON s.account_id = a.account_id WHERE 1=1"]
        count_params = []
        
        if account_id:
            count_parts.append(" AND s.account_id = ?")
            count_params.append(account_id)
        
        if search:
            count_parts.append(" AND (s.subscription_name LIKE ? OR a.name LIKE ?)")
            count_params.extend([f"%{search}%", f"%{search}%"])
        
        count_query = "".join(count_parts)
        count_result, count_error = safe_query_db(count_query, tuple(count_params) if count_params else None)
        
        if count_error:
            return func.HttpResponse(
                json.dumps({"error": count_error}),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        total = count_result[0]["count"] if count_result else 0
        total_pages = (total + page_size - 1) // page_size if total > 0 else 1
        
        response_data = {
            "data": results or [],
            "pagination": {
                "page": page,
                "page_size": page_size,
                "total": total,
                "total_pages": total_pages
            }
        }
        
        return func.HttpResponse(
            json.dumps(response_data),
            mimetype="application/json",
            status_code=200,
            headers={"Access-Control-Allow-Origin": "*"}
        )
        
    except Exception as e:
        logging.error(f"Subscriptions endpoint error: {str(e)}")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"}
        )

@app.route(route="unknown", auth_level=func.AuthLevel.ANONYMOUS)
def get_unknown_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/unknown
    Returns subscriptions that couldn't be mapped to accounts
    """
    logging.info("Unknown subscriptions endpoint called")
    
    try:
        query = "SELECT id, subscription_name, subscription_guid FROM subscriptions_unknown ORDER BY subscription_name"
        results, error = safe_query_db(query)
        
        if error:
            return func.HttpResponse(
                json.dumps({"error": error}),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        return func.HttpResponse(
            json.dumps({"data": results or []}),
            mimetype="application/json",
            status_code=200,
            headers={"Access-Control-Allow-Origin": "*"}
        )
        
    except Exception as e:
        logging.error(f"Unknown subscriptions endpoint error: {str(e)}")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"}
        )
