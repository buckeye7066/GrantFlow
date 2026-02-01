#!/bin/bash
#
# Reproduction script for POST /api/grants/from-opportunity Postgres FK violation bug
#
# This script:
# 1. Starts a Postgres container
# 2. Runs migrations
# 3. Starts the backend
# 4. Runs test cases that reproduce the bug
# 5. Reports pass/fail for each case
#
# Expected behavior AFTER fix:
# - Case A: Invalid profile_id with valid org_id -> 400/404 (not 500)
# - Case B: Invalid profile_id without org_id -> 400/404 (not 500)
# - Case C: Valid profile_id + valid org_id -> 201
# - Case D: Invalid deadline formats -> 201 with null deadline (not 500)
# - Case E: Data validation error -> 400 with error: "invalid_data"
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Configuration
PG_PORT=5433
PG_USER=grantflow_test
PG_PASSWORD=grantflow_test_password
PG_DB=grantflow_test
API_PORT=8081
DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}"

cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"
    # Kill backend if running
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        kill "$BACKEND_PID" 2>/dev/null || true
        wait "$BACKEND_PID" 2>/dev/null || true
    fi
    # Stop postgres container
    docker stop grantflow-postgres-test 2>/dev/null || true
    docker rm grantflow-postgres-test 2>/dev/null || true
}

trap cleanup EXIT

log_test() {
    local name="$1"
    local expected_status="$2"
    local actual_status="$3"
    local expected_error="$4"
    local actual_body="$5"

    TESTS_RUN=$((TESTS_RUN + 1))

    local status_match=false
    # Handle multiple expected statuses (e.g., "400|404")
    for expected in $(echo "$expected_status" | tr '|' ' '); do
        if [ "$actual_status" = "$expected" ]; then
            status_match=true
            break
        fi
    done

    local error_match=true
    if [ -n "$expected_error" ]; then
        if ! echo "$actual_body" | grep -q "$expected_error"; then
            error_match=false
        fi
    fi

    if $status_match && $error_match; then
        echo -e "${GREEN}[PASS]${NC} $name (status: $actual_status)"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        echo -e "${RED}[FAIL]${NC} $name"
        echo "  Expected status: $expected_status, Got: $actual_status"
        if [ -n "$expected_error" ]; then
            echo "  Expected error containing: $expected_error"
        fi
        echo "  Response body: $actual_body"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

echo "=========================================="
echo "Postgres FK Violation Repro Script"
echo "=========================================="
echo ""

# Step 1: Start Postgres
echo -e "${YELLOW}Step 1: Starting Postgres container...${NC}"
docker run -d \
    --name grantflow-postgres-test \
    -e POSTGRES_USER=$PG_USER \
    -e POSTGRES_PASSWORD=$PG_PASSWORD \
    -e POSTGRES_DB=$PG_DB \
    -p $PG_PORT:5432 \
    postgres:15-alpine

# Wait for Postgres to be ready
echo "Waiting for Postgres to be ready..."
for i in {1..30}; do
    if docker exec grantflow-postgres-test pg_isready -U $PG_USER -d $PG_DB 2>/dev/null; then
        echo "Postgres is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}Postgres failed to start${NC}"
        exit 1
    fi
    sleep 1
done

# Step 2: Run migrations
echo -e "\n${YELLOW}Step 2: Running Postgres migrations...${NC}"
DATABASE_URL="$DATABASE_URL" node backend/db/migrate.js 2>&1 | tail -20

# Step 3: Seed minimal test data
echo -e "\n${YELLOW}Step 3: Seeding test data...${NC}"
docker exec grantflow-postgres-test psql -U $PG_USER -d $PG_DB -c "
-- Create a valid organization
INSERT INTO organizations (id, name, applicant_type, created_at, updated_at)
VALUES ('org-valid-test', 'Test Organization', 'nonprofit', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Create a valid profile linked to the organization
INSERT INTO profiles (id, display_name, organization_id, applicant_type, created_at, updated_at)
VALUES ('profile-valid-test', 'Test Profile', 'org-valid-test', 'nonprofit', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
"

# Step 4: Start backend with Postgres
echo -e "\n${YELLOW}Step 4: Starting backend with Postgres...${NC}"
DATABASE_URL="$DATABASE_URL" \
PORT=$API_PORT \
NODE_ENV=test \
ADMIN_TOKEN=test-admin \
AUTH_JWT_SECRET=test-secret-for-testing \
node backend/start.js > /tmp/backend-test.log 2>&1 &
BACKEND_PID=$!

# Wait for backend to be ready
echo "Waiting for backend to start..."
for i in {1..30}; do
    if curl -s "http://localhost:$API_PORT/api/version" > /dev/null 2>&1; then
        echo "Backend is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}Backend failed to start. Logs:${NC}"
        cat /tmp/backend-test.log | tail -50
        exit 1
    fi
    sleep 1
done

API_URL="http://localhost:$API_PORT"
AUTH_HEADER="Authorization: Bearer test-admin"

echo -e "\n${YELLOW}Step 5: Running test cases...${NC}"
echo ""

# ============================================
# Case A: Invalid profile_id WITH valid org_id
# This is the CRITICAL case that caused 500 in production
# ============================================
echo "Case A: Invalid profile_id WITH valid organization_id"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/grants/from-opportunity" \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d '{
        "profile_id": "does-not-exist-profile",
        "organization_id": "org-valid-test",
        "opportunity_data": {
            "title": "Test Grant A",
            "sponsor": "Test Foundation"
        }
    }')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
log_test "Invalid profile_id with valid org_id returns 400/404 (not 500)" "400|404" "$HTTP_CODE" "not found\|profile_not_found" "$BODY"

# Verify no grant was inserted
GRANT_COUNT=$(docker exec grantflow-postgres-test psql -U $PG_USER -d $PG_DB -t -c \
    "SELECT COUNT(*) FROM grants WHERE title = 'Test Grant A';" | tr -d ' ')
if [ "$GRANT_COUNT" = "0" ]; then
    echo -e "  ${GREEN}[VERIFY]${NC} No grant row inserted (correct)"
else
    echo -e "  ${RED}[VERIFY FAIL]${NC} Grant was inserted despite error"
    TESTS_FAILED=$((TESTS_FAILED + 1))
fi

# ============================================
# Case B: Invalid profile_id WITHOUT org_id
# ============================================
echo ""
echo "Case B: Invalid profile_id without organization_id"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/grants/from-opportunity" \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d '{
        "profile_id": "another-nonexistent-profile",
        "opportunity_data": {
            "title": "Test Grant B",
            "sponsor": "Test Foundation"
        }
    }')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
log_test "Invalid profile_id without org_id returns 400/404 (not 500)" "400|404" "$HTTP_CODE" "not found\|profile_not_found" "$BODY"

# ============================================
# Case C: Valid profile_id + valid org_id (control)
# ============================================
echo ""
echo "Case C: Valid profile_id + valid organization_id (control test)"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/grants/from-opportunity" \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d '{
        "profile_id": "profile-valid-test",
        "organization_id": "org-valid-test",
        "opportunity_data": {
            "title": "Test Grant C - Valid",
            "sponsor": "Test Foundation",
            "deadline": "2026-12-31"
        }
    }')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
log_test "Valid profile_id + org_id returns 200/201" "200|201" "$HTTP_CODE" "" "$BODY"

# Verify grant was inserted
GRANT_COUNT=$(docker exec grantflow-postgres-test psql -U $PG_USER -d $PG_DB -t -c \
    "SELECT COUNT(*) FROM grants WHERE title = 'Test Grant C - Valid';" | tr -d ' ')
if [ "$GRANT_COUNT" = "1" ]; then
    echo -e "  ${GREEN}[VERIFY]${NC} Grant row inserted correctly"
else
    echo -e "  ${RED}[VERIFY FAIL]${NC} Grant was NOT inserted"
    TESTS_FAILED=$((TESTS_FAILED + 1))
fi

# ============================================
# Case D: Invalid deadline formats
# ============================================
echo ""
echo "Case D1: Invalid deadline '2026-13-45' (impossible month/day)"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/grants/from-opportunity" \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d '{
        "profile_id": "profile-valid-test",
        "opportunity_data": {
            "title": "Test Grant D1 - Bad Date",
            "sponsor": "Test Foundation",
            "deadline": "2026-13-45"
        }
    }')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
# Should succeed (201) but with null deadline, not fail with 500
log_test "Invalid deadline '2026-13-45' returns 201 (date normalized to null)" "200|201" "$HTTP_CODE" "" "$BODY"

# Verify deadline is null
DEADLINE=$(docker exec grantflow-postgres-test psql -U $PG_USER -d $PG_DB -t -c \
    "SELECT deadline FROM grants WHERE title = 'Test Grant D1 - Bad Date';" | tr -d ' ')
if [ "$DEADLINE" = "" ] || [ "$DEADLINE" = "null" ]; then
    echo -e "  ${GREEN}[VERIFY]${NC} Deadline stored as NULL (correct)"
else
    echo -e "  ${RED}[VERIFY FAIL]${NC} Invalid deadline was stored: '$DEADLINE'"
    TESTS_FAILED=$((TESTS_FAILED + 1))
fi

echo ""
echo "Case D2: Invalid deadline '2026-02-30' (Feb 30 doesn't exist)"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/grants/from-opportunity" \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d '{
        "profile_id": "profile-valid-test",
        "opportunity_data": {
            "title": "Test Grant D2 - Feb 30",
            "sponsor": "Test Foundation",
            "deadline": "2026-02-30"
        }
    }')
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
log_test "Invalid deadline '2026-02-30' returns 201 (date normalized to null)" "200|201" "$HTTP_CODE" "" "$BODY"

# ============================================
# Case E: Trigger Postgres data validation error
# We'll try to insert a very long string that exceeds column limits
# ============================================
echo ""
echo "Case E: Trigger data validation error (extremely long title)"
LONG_TITLE=$(python3 -c "print('X' * 100000)" 2>/dev/null || printf 'X%.0s' {1..100000})
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/grants/from-opportunity" \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d "{
        \"profile_id\": \"profile-valid-test\",
        \"opportunity_data\": {
            \"title\": \"$LONG_TITLE\",
            \"sponsor\": \"Test Foundation\"
        }
    }" 2>/dev/null)
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
# This should either succeed (if TEXT has no limit) or return 400 with invalid_data
# Either way, it should NOT return 500
if [ "$HTTP_CODE" = "500" ]; then
    echo -e "${RED}[FAIL]${NC} Long title causes 500 (should be 400 or succeed)"
    TESTS_FAILED=$((TESTS_FAILED + 1))
else
    echo -e "${GREEN}[PASS]${NC} Long title handled gracefully (status: $HTTP_CODE)"
    TESTS_PASSED=$((TESTS_PASSED + 1))
fi
TESTS_RUN=$((TESTS_RUN + 1))

# ============================================
# Summary
# ============================================
echo ""
echo "=========================================="
echo "TEST SUMMARY"
echo "=========================================="
echo -e "Tests run: $TESTS_RUN"
echo -e "Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Failed: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}ALL TESTS PASSED${NC}"
    exit 0
else
    echo -e "${RED}SOME TESTS FAILED${NC}"
    echo ""
    echo "Backend logs (last 30 lines):"
    tail -30 /tmp/backend-test.log
    exit 1
fi
