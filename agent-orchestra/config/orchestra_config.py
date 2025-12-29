"""
Orchestra configuration - STRICT MODE ENFORCED
"""

# STRICT FLAGS - DO NOT CHANGE WITHOUT APPROVAL
STRICT_COMPLETION_MODE = True
MAX_AGENT_RETRIES = 1
DISABLE_INFRA_PROVISIONING = True
LOCAL_SUCCESS_IS_AUTHORITY = True
REQUIRE_BUILD_BEFORE_DEPLOY = True

# Agent endpoints (update with your actual endpoints)
AGENT_ENDPOINTS = {
    "claude": None,       # Claude provides code blocks, not execution
    "cursor": "local",    # Cursor executes locally
    "anya": "openai",
    "chatgpt": "openai",
    "vercel": "vercel_api",
    "railway": "railway_api",
    "cloudflare": "cloudflare_api",
}

# Anti-patterns to detect and block
BLOCKED_PATTERNS = [
    "claude retrying deployments",
    "railway provisioning databases",
    "cloudflare running workers",
    "multiple agents touching same task",
    "autonomous mode without completion definition",
]


