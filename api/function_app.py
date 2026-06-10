import azure.functions as func
import os
import json
import logging

# NOTE: switch away from pyodbc if possible later
import pyodbc

app = func.FunctionApp(http_auth_level=func.HttpAuthLevel.ANONYMOUS)

def get_conn():
    conn_str = os.environ.get("AzureSQLConnectionString")
    if not conn_str:
        raise Exception("Missing AzureSQLConnectionString")
    return pyodbc.connect(conn_str)

# ✅ Health check (IMPORTANT for debugging)
@app.route(route="health")
def health(req: func.HttpRequest) -> func.HttpResponse:
    return func.HttpResponse("API is running", status_code=200)

# ✅ Example: summary endpoint
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

# ✅ Example: subscriptions endpoint
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
