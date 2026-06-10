import azure.functions as func
import os
import json
import logging

# Use pymssql instead of pyodbc
import pymssql

app = func.FunctionApp(http_auth_level=func.HttpAuthLevel.ANONYMOUS)

def get_conn():
    conn_str = os.environ.get("AzureSQLConnectionString")
    if not conn_str:
        raise Exception("Missing AzureSQLConnectionString")
    
    # Parse connection string: 
    # Format: SERVER=xxx;DATABASE=xxx;UID=xxx;PWD=xxx
    parts = dict(part.split('=', 1) for part in conn_str.split(';') if '=' in part)
    
    return pymssql.connect(
        server=parts.get('SERVER', ''),
        database=parts.get('DATABASE', ''),
        user=parts.get('UID', ''),
        password=parts.get('PWD', '')
    )

@app.route(route="health")
def health(req: func.HttpRequest) -> func.HttpResponse:
    return func.HttpResponse("API is running", status_code=200)

@app.route(route="summary")
def summary(req: func.HttpRequest) -> func.HttpResponse:
    try:
        conn = get_conn()
        cursor = conn.cursor()
        cursor.execute("""
SELECT COUNT(*) AS total_accounts
FROM Accounts
""")
        row = cursor.fetchone()
        result = {
            "total_accounts": row[0]
        }
        return func.HttpResponse(
            json.dumps(result),
            mimetype="application/json",
            status_code=200
        )
    except Exception as e:
        logging.exception("DB Error")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            status_code=500
        )

@app.route(route="subscriptions")
def subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    try:
        conn = get_conn()
        cursor = conn.cursor()
        cursor.execute("""
SELECT TOP 50 subscription_id, account_id
FROM Subscriptions
""")
        results = []
        for row in cursor.fetchall():
            results.append({
                "subscription_id": row[0],
                "account_id": row[1]
            })
        return func.HttpResponse(
            json.dumps(results),
            mimetype="application/json",
            status_code=200
        )
    except Exception as e:
        logging.exception("DB Error")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            status_code=500
        )