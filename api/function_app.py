"""
Azure Function API for Account-Subscription Mapping
Uses Data API Builder managed endpoints
"""
import azure.functions as func
import aiohttp
import json
import os

app = func.FunctionApp(http_auth_level=func.HttpAuthLevel.ANONYMOUS)

# Data API base URL - relative path within Static Web App
DATA_API_BASE = "/data-api/rest"

async def call_data_api(endpoint: str, method: str = "GET", body: dict = None):
    """Call the managed Data API"""
    # For local/dev, construct full URL; for production SWA, use relative
    url = f"{DATA_API_BASE}{endpoint}"
    
    try:
        async with aiohttp.ClientSession() as session:
            headers = {"Content-Type": "application/json"}
            
            if method == "GET":
                async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                    if resp.status == 200:
                        return await resp.json()
                    else:
                        return {"error": f"API returned {resp.status}", "details": await resp.text()}
            else:
                async with session.request(method, url, json=body, headers=headers) as resp:
                    if resp.status in [200, 201]:
                        return await resp.json()
                    else:
                        return {"error": f"API returned {resp.status}"}
    except Exception as e:
        return {"error": f"Failed to call Data API: {str(e)}", "endpoint": endpoint}

@app.route(route="summary", auth_level=func.HttpAuthLevel.ANONYMOUS)
async def get_summary(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/summary - Returns summary statistics"""
    try:
        # Get all data
        accounts_resp = await call_data_api("/Accounts")
        subs_resp = await call_data_api("/Subscriptions")
        unknown_resp = await call_data_api("/SubscriptionsUnknown")
        
        # Handle errors
        if "error" in accounts_resp or "error" in subs_resp or "error" in unknown_resp:
            return func.HttpResponse(
                json.dumps({
                    "error": "Data API error",
                    "accounts_error": accounts_resp.get("error"),
                    "subs_error": subs_resp.get("error"),
                    "unknown_error": unknown_resp.get("error")
                }),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        accounts = accounts_resp.get("value", [])
        subs = subs_resp.get("value", [])
        unknown = unknown_resp.get("value", [])
        
        # Count accounts with multiple subscriptions
        accounts_with_multi = 0
        if subs:
            account_counts = {}
            for sub in subs:
                acc_id = sub.get("account_id")
                if acc_id:
                    account_counts[acc_id] = account_counts.get(acc_id, 0) + 1
            accounts_with_multi = sum(1 for count in account_counts.values() if count > 1)
        
        result = {
            "total_accounts": len(accounts),
            "total_subscriptions": len(subs),
            "total_unknown": len(unknown),
            "accounts_with_multiple_subscriptions": accounts_with_multi
        }
        
        return func.HttpResponse(
            json.dumps(result),
            mimetype="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
            status_code=200
        )
        
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"}
        )

@app.route(route="accounts", auth_level=func.HttpAuthLevel.ANONYMOUS)
async def get_accounts(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/accounts - List all accounts"""
    try:
        # Get accounts and subscriptions
        accounts_resp = await call_data_api("/Accounts")
        subs_resp = await call_data_api("/Subscriptions")
        
        if "error" in accounts_resp:
            return func.HttpResponse(
                json.dumps(accounts_resp),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        accounts = accounts_resp.get("value", [])
        subs = subs_resp.get("value", [])
        
        # Count subscriptions per account
        sub_counts = {}
        for sub in subs:
            acc_id = sub.get("account_id")
            if acc_id:
                sub_counts[acc_id] = sub_counts.get(acc_id, 0) + 1
        
        for account in accounts:
            account["subscription_count"] = sub_counts.get(account.get("account_id"), 0)
        
        # Apply search filter if provided
        search = req.params.get("search", "").lower()
        if search:
            accounts = [a for a in accounts if search in a.get("name", "").lower() 
                       or search in a.get("company_id", "").lower()]
        
        return func.HttpResponse(
            json.dumps({"data": accounts, "pagination": {"total": len(accounts)}}),
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
async def get_account_detail(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/accounts/{account_id} - Get account details"""
    try:
        account_id = req.route_params.get("account_id")
        
        if not account_id:
            return func.HttpResponse(
                json.dumps({"error": "account_id is required"}),
                mimetype="application/json",
                status_code=400
            )
        
        # Get all accounts
        accounts_resp = await call_data_api("/Accounts")
        accounts = accounts_resp.get("value", [])
        
        # Find the requested account
        account = next((a for a in accounts if a.get("account_id") == int(account_id)), None)
        
        if not account:
            return func.HttpResponse(
                json.dumps({"error": "Account not found"}),
                mimetype="application/json",
                status_code=404
            )
        
        # Get subscriptions for this account
        subs_resp = await call_data_api("/Subscriptions")
        subscriptions = [s for s in subs_resp.get("value", []) if s.get("account_id") == int(account_id)]
        
        result = {
            "account": account,
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
async def get_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/subscriptions - List all subscriptions"""
    try:
        # Get subscriptions and accounts
        subs_resp = await call_data_api("/Subscriptions")
        accounts_resp = await call_data_api("/Accounts")
        
        if "error" in subs_resp:
            return func.HttpResponse(
                json.dumps(subs_resp),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        subs = subs_resp.get("value", [])
        accounts = {a.get("account_id"): a for a in accounts_resp.get("value", [])}
        
        # Enrich subscriptions with account info
        for sub in subs:
            acc_id = sub.get("account_id")
            if acc_id and acc_id in accounts:
                sub["account_name"] = accounts[acc_id].get("name")
                sub["company_id"] = accounts[acc_id].get("company_id")
        
        # Apply search filter
        search = req.params.get("search", "").lower()
        if search:
            subs = [s for s in subs if search in s.get("subscription_name", "").lower() 
                   or search in s.get("account_name", "").lower()]
        
        return func.HttpResponse(
            json.dumps({"data": subs, "pagination": {"total": len(subs)}}),
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
async def get_unknown_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    """GET /api/unknown - List unmapped subscriptions"""
    try:
        resp = await call_data_api("/SubscriptionsUnknown")
        
        if "error" in resp:
            return func.HttpResponse(
                json.dumps(resp),
                mimetype="application/json",
                status_code=500,
                headers={"Access-Control-Allow-Origin": "*"}
            )
        
        return func.HttpResponse(
            json.dumps({"data": resp.get("value", [])}),
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
