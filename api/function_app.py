"""
Azure Function API for Account-Subscription Mapping
Python v2 programming model
"""
import azure.functions as func
import os
import json
import pyodbc
from typing import List, Dict, Any

app = func.FunctionApp(http_auth_level=func.HttpAuthLevel.ANONYMOUS)


def get_db_connection():
    conn_str = os.environ.get("AzureSQLConnectionString", "")
    if not conn_str:
        raise ValueError("AzureSQLConnectionString environment variable is not set.")
    return pyodbc.connect(conn_str)


def query_db(query: str, params: tuple = None) -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params or ())
        columns = [col[0] for col in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]


def scalar_db(query: str, params: tuple = None):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params or ())
        return cursor.fetchone()[0]


def json_response(body, status=200):
    return func.HttpResponse(
        json.dumps(body, default=str),
        mimetype="application/json",
        status_code=status,
        headers={"Access-Control-Allow-Origin": "*"}
    )


# ── GET /api/accounts ────────────────────────────────────────────────────────
@app.route(route="accounts", methods=["GET"])
def get_accounts(req: func.HttpRequest) -> func.HttpResponse:
    try:
        search    = req.params.get("search", "")
        page      = max(1, int(req.params.get("page", 1)))
        page_size = min(200, int(req.params.get("page_size", 50)))
        offset    = (page - 1) * page_size

        where  = "WHERE a.name LIKE ? OR a.company_id LIKE ?" if search else ""
        params = (f"%{search}%", f"%{search}%") if search else ()

        count_sql = f"SELECT COUNT(*) FROM accounts a {where}"
        total     = scalar_db(count_sql, params)

        data_sql = f"""
            SELECT
                a.account_id,
                a.name          AS account_name,
                a.company_id,
                COUNT(s.subscription_id) AS subscription_count
            FROM accounts a
            LEFT JOIN subscriptions s ON a.account_id = s.account_id
            {where}
            GROUP BY a.account_id, a.name, a.company_id
            ORDER BY a.name
            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
        """
        rows = query_db(data_sql, params + (offset, page_size))

        return json_response({
            "data": rows,
            "pagination": {
                "page": page,
                "page_size": page_size,
                "total": total,
                "total_pages": max(1, (total + page_size - 1) // page_size)
            }
        })
    except Exception as e:
        return json_response({"error": str(e)}, 500)


# ── GET /api/accounts/{account_id} ──────────────────────────────────────────
@app.route(route="accounts/{account_id}", methods=["GET"])
def get_account_detail(req: func.HttpRequest) -> func.HttpResponse:
    try:
        account_id = req.route_params.get("account_id")
        if not account_id:
            return json_response({"error": "account_id is required"}, 400)

        accounts = query_db(
            "SELECT account_id, name AS account_name, company_id FROM accounts WHERE account_id = ?",
            (account_id,)
        )
        if not accounts:
            return json_response({"error": "Account not found"}, 404)

        subs = query_db(
            """
            SELECT subscription_id, subscription_name, subscription_guid
            FROM subscriptions
            WHERE account_id = ?
            ORDER BY subscription_name
            """,
            (account_id,)
        )

        return json_response({"account": accounts[0], "subscriptions": subs})
    except Exception as e:
        return json_response({"error": str(e)}, 500)


# ── GET /api/subscriptions ───────────────────────────────────────────────────
@app.route(route="subscriptions", methods=["GET"])
def get_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    try:
        account_id = req.params.get("account_id", "")
        search     = req.params.get("search", "")
        page       = max(1, int(req.params.get("page", 1)))
        page_size  = min(200, int(req.params.get("page_size", 50)))
        offset     = (page - 1) * page_size

        conditions = []
        params: list = []

        if account_id:
            conditions.append("s.account_id = ?")
            params.append(account_id)
        if search:
            conditions.append("(s.subscription_name LIKE ? OR a.name LIKE ?)")
            params.extend([f"%{search}%", f"%{search}%"])

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

        base_sql = f"""
            FROM subscriptions s
            JOIN accounts a ON s.account_id = a.account_id
            {where}
        """

        total = scalar_db(f"SELECT COUNT(*) {base_sql}", tuple(params))

        data_sql = f"""
            SELECT
                s.subscription_id,
                s.subscription_name,
                s.subscription_guid,
                a.account_id,
                a.name  AS account_name,
                a.company_id
            {base_sql}
            ORDER BY s.subscription_name
            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
        """
        rows = query_db(data_sql, tuple(params) + (offset, page_size))

        return json_response({
            "data": rows,
            "pagination": {
                "page": page,
                "page_size": page_size,
                "total": total,
                "total_pages": max(1, (total + page_size - 1) // page_size)
            }
        })
    except Exception as e:
        return json_response({"error": str(e)}, 500)


# ── GET /api/unknown ─────────────────────────────────────────────────────────
@app.route(route="unknown", methods=["GET"])
def get_unknown_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    try:
        rows = query_db(
            "SELECT id, subscription_name, subscription_guid FROM subscriptions_unknown ORDER BY subscription_name"
        )
        return json_response({"data": rows})
    except Exception as e:
        return json_response({"error": str(e)}, 500)


# ── GET /api/summary ─────────────────────────────────────────────────────────
@app.route(route="summary", methods=["GET"])
def get_summary(req: func.HttpRequest) -> func.HttpResponse:
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()

            cur.execute("SELECT COUNT(*) FROM accounts")
            total_accounts = cur.fetchone()[0]

            cur.execute("SELECT COUNT(*) FROM subscriptions")
            total_subscriptions = cur.fetchone()[0]

            cur.execute("SELECT COUNT(*) FROM subscriptions_unknown")
            total_unknown = cur.fetchone()[0]

            cur.execute("""
                SELECT COUNT(*) FROM (
                    SELECT account_id FROM subscriptions
                    GROUP BY account_id HAVING COUNT(*) > 1
                ) AS multi
            """)
            accounts_with_multi = cur.fetchone()[0]

        return json_response({
            "total_accounts": total_accounts,
            "total_subscriptions": total_subscriptions,
            "total_unknown": total_unknown,
            "accounts_with_multiple_subscriptions": accounts_with_multi
        })
    except Exception as e:
        return json_response({"error": str(e)}, 500)
