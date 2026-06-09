"""
Azure Function API for Account-Subscription Mapping
Using pyodbc to connect directly to Azure SQL Database
"""
import azure.functions as func
import os
import json
import pyodbc
from typing import List, Dict, Any
import logging

# Configure logging
logger = logging.getLogger()

def get_db_connection() -> str:
    """Get database connection string from environment variable"""
    conn_str = os.environ.get("AzureSQLConnectionString")
    if not conn_str:
        raise ValueError("AzureSQLConnectionString environment variable not configured")
    return conn_str

def add_cors_headers(req: func.HttpRequest, response: func.HttpResponse) -> func.HttpResponse:
    """Add CORS headers to response"""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response

# ============== AZURE FUNCTIONS ==============

def get_summary(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/summary - Returns summary statistics"""
    try:
        conn_str = get_db_connection()
        conn = pyodbc.connect(conn_str)
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
        
        response = func.HttpResponse(
            json.dumps(result),
            mimetype="application/json",
            status_code=200
        )
        return add_cors_headers(req, response)
        
    except ValueError as e:
        response = func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500
        )
        return add_cors_headers(req, response)
    except Exception as e:
        logger.error(f"Error in get_summary: {str(e)}")
        response = func.HttpResponse(
            json.dumps({"error": f"Database error: {str(e)}"}),
            mimetype="application/json",
            status_code=500
        )
        return add_cors_headers(req, response)

def get_accounts(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/accounts - Returns all accounts with subscription counts"""
    try:
        search = req.params.get("search", "")
        page = int(req.params.get("page", 1))
        page_size = int(req.params.get("page_size", 50))
        
        conn_str = get_db_connection()
        conn = pyodbc.connect(conn_str)
        cursor = conn.cursor()
        
        # Build query
        query = """
            SELECT 
                a.account_id,
                a.name AS account_name,
                a.company_id,
                COUNT(s.subscription_id) AS subscription_count
            FROM accounts a
            LEFT JOIN subscriptions s ON a.account_id = s.account_id
        """
        
        count_query = "SELECT COUNT(*) FROM accounts"
        
        if search:
            query += " WHERE a.name LIKE ? OR a.company_id LIKE ?"
            count_query += " WHERE name LIKE ? OR company_id LIKE ?"
        
        query += " GROUP BY a.account_id, a.name, a.company_id ORDER BY a.name"
        
        # Get total count
        if search:
            cursor.execute(count_query, (f"%{search}%", f"%{search}%"))
        else:
            cursor.execute(count_query)
        
        total = cursor.fetchone()[0]
        
        # Calculate offset
        offset = (page - 1) * page_size
        query += f" OFFSET {offset} ROWS FETCH NEXT {page_size} ROWS ONLY"
        
        # Execute main query
        if search:
            cursor.execute(query, (f"%{search}%", f"%{search}%"))
        else:
            cursor.execute(query)
        
        columns = [column[0] for column in cursor.description]
        results = []
        
        for row in cursor.fetchall():
            results.append(dict(zip(columns, row)))
        
        cursor.close()
        conn.close()
        
        total_pages = (total + page_size - 1) // page_size
        
        response = func.HttpResponse(
            json.dumps({
                "data": results,
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "total_pages": total_pages
                }
            }),
            mimetype="application/json",
            status_code=200
        )
        return add_cors_headers(req, response)
        
    except ValueError as e:
        response = func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500
        )
        return add_cors_headers(req, response)
    except Exception as e:
        logger.error(f"Error in get_accounts: {str(e)}")
        response = func.HttpResponse(
            json.dumps({"error": f"Database error: {str(e)}"}),
            mimetype="application/json",
            status_code=500
        )
        return add_cors_headers(req, response)

def get_account_detail(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/accounts/{account_id} - Returns account details with subscriptions"""
    try:
        account_id = req.route_params.get("account_id")
        
        if not account_id:
            response = func.HttpResponse(
                json.dumps({"error": "account_id is required"}),
                mimetype="application/json",
                status_code=400
            )
            return add_cors_headers(req, response)
        
        conn_str = get_db_connection()
        conn = pyodbc.connect(conn_str)
        cursor = conn.cursor()
        
        # Get account info
        cursor.execute(
            "SELECT account_id, name AS account_name, company_id FROM accounts WHERE account_id = ?",
            (account_id,)
        )
        columns = [column[0] for column in cursor.description]
        account_row = cursor.fetchone()
        
        if not account_row:
            cursor.close()
            conn.close()
            response = func.HttpResponse(
                json.dumps({"error": "Account not found"}),
                mimetype="application/json",
                status_code=404
            )
            return add_cors_headers(req, response)
        
        account = dict(zip(columns, account_row))
        
        # Get subscriptions
        cursor.execute("""
            SELECT subscription_id, subscription_name, subscription_guid
            FROM subscriptions
            WHERE account_id = ?
            ORDER BY subscription_name
        """, (account_id,))
        
        columns = [column[0] for column in cursor.description]
        subscriptions = []
        
        for row in cursor.fetchall():
            subscriptions.append(dict(zip(columns, row)))
        
        cursor.close()
        conn.close()
        
        result = {
            "account": account,
            "subscriptions": subscriptions
        }
        
        response = func.HttpResponse(
            json.dumps(result),
            mimetype="application/json",
            status_code=200
        )
        return add_cors_headers(req, response)
        
    except ValueError as e:
        response = func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500
        )
        return add_cors_headers(req, response)
    except Exception as e:
        logger.error(f"Error in get_account_detail: {str(e)}")
        response = func.HttpResponse(
            json.dumps({"error": f"Database error: {str(e)}"}),
            mimetype="application/json",
            status_code=500
        )
        return add_cors_headers(req, response)

def get_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/subscriptions - Returns all subscriptions"""
    try:
        search = req.params.get("search", "")
        account_id = req.params.get("account_id")
        page = int(req.params.get("page", 1))
        page_size = int(req.params.get("page_size", 50))
        
        conn_str = get_db_connection()
        conn = pyodbc.connect(conn_str)
        cursor = conn.cursor()
        
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
            params.append(account_id)
        
        if search:
            query += " AND (s.subscription_name LIKE ? OR a.name LIKE ?)"
            params.extend([f"%{search}%", f"%{search}%"])
        
        # Get total count
        count_query = query.replace(
            "SELECT s.subscription_id, s.subscription_name, s.subscription_guid, a.account_id, a.name AS account_name, a.company_id", 
            "SELECT COUNT(*)"
        )
        
        cursor.execute(count_query, tuple(params))
        total = cursor.fetchone()[0]
        
        query += " ORDER BY s.subscription_name"
        
        # Add pagination
        offset = (page - 1) * page_size
        query += f" OFFSET {offset} ROWS FETCH NEXT {page_size} ROWS ONLY"
        
        cursor.execute(query, tuple(params))
        
        columns = [column[0] for column in cursor.description]
        results = []
        
        for row in cursor.fetchall():
            results.append(dict(zip(columns, row)))
        
        cursor.close()
        conn.close()
        
        total_pages = (total + page_size - 1) // page_size
        
        response = func.HttpResponse(
            json.dumps({
                "data": results,
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "total_pages": total_pages
                }
            }),
            mimetype="application/json",
            status_code=200
        )
        return add_cors_headers(req, response)
        
    except ValueError as e:
        response = func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500
        )
        return add_cors_headers(req, response)
    except Exception as e:
        logger.error(f"Error in get_subscriptions: {str(e)}")
        response = func.HttpResponse(
            json.dumps({"error": f"Database error: {str(e)}"}),
            mimetype="application/json",
            status_code=500
        )
        return add_cors_headers(req, response)

def get_unknown(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/unknown - Returns unmapped subscriptions"""
    try:
        conn_str = get_db_connection()
        conn = pyodbc.connect(conn_str)
        cursor = conn.cursor()
        
        cursor.execute("SELECT id, subscription_name, subscription_guid FROM subscriptions_unknown ORDER BY subscription_name")
        
        columns = [column[0] for column in cursor.description]
        results = []
        
        for row in cursor.fetchall():
            results.append(dict(zip(columns, row)))
        
        cursor.close()
        conn.close()
        
        response = func.HttpResponse(
            json.dumps({"data": results}),
            mimetype="application/json",
            status_code=200
        )
        return add_cors_headers(req, response)
        
    except ValueError as e:
        response = func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500
        )
        return add_cors_headers(req, response)
    except Exception as e:
        logger.error(f"Error in get_unknown: {str(e)}")
        response = func.HttpResponse(
            json.dumps({"error": f"Database error: {str(e)}"}),
            mimetype="application/json",
            status_code=500
        )
        return add_cors_headers(req, response)

# App registration
app = func.FunctionApp(http_auth_level=func.HttpAuthLevel.ANONYMOUS)

# Register routes
app.register_func(get_summary)
app.register_func(get_accounts)
app.register_func(get_account_detail)
app.register_func(get_subscriptions)
app.register_func(get_unknown)
