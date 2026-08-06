#!/bin/bash

# Test script to systematically identify failure points in /api/grants/from-opportunity

BASE_URL="http://localhost:3457"
TOKEN="test-admin-token"

echo "========================================="
echo "Testing /api/grants/from-opportunity Edge Cases"
echo "========================================="
echo ""

# Test 1: Valid request with profile_id (baseline - should work)
echo "[TEST 1] Valid request with profile_id"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"profile_id\": \"profile-demo-tennessee-stem-student\",
    \"opportunity_data\": {
      \"title\": \"Test Valid $(date +%s)\",
      \"sponsor\": \"Test\",
      \"url\": \"https://example.com/test-$(date +%s)\"
    }
  }" \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: (.id // .error), message: .message}'
echo ""

# Test 2: Missing profile_id AND organization_id
echo "[TEST 2] Missing profile_id AND organization_id (should return 400)"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "opportunity_data": {
      "title": "Test Missing IDs",
      "sponsor": "Test"
    }
  }' \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: .error, message: .message}'
echo ""

# Test 3: Invalid opportunity_data type (string instead of object)
echo "[TEST 3] Invalid opportunity_data type (should return 400)"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "profile_id": "profile-demo-tennessee-stem-student",
    "opportunity_data": "invalid string"
  }' \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: .error, message: .message}'
echo ""

# Test 4: Missing title in opportunity_data
echo "[TEST 4] Missing title in opportunity_data (should return 400)"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "profile_id": "profile-demo-tennessee-stem-student",
    "opportunity_data": {
      "sponsor": "Test"
    }
  }' \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: .error, message: .message}'
echo ""

# Test 5: Empty title in opportunity_data
echo "[TEST 5] Empty title in opportunity_data (should return 400)"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "profile_id": "profile-demo-tennessee-stem-student",
    "opportunity_data": {
      "title": "",
      "sponsor": "Test"
    }
  }' \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: .error, message: .message}'
echo ""

# Test 6: Non-existent profile_id (should return 403)
echo "[TEST 6] Non-existent profile_id (should return 403)"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"profile_id\": \"nonexistent-$(date +%s)\",
    \"opportunity_data\": {
      \"title\": \"Test\",
      \"sponsor\": \"Test\"
    }
  }" \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: .error, message: .message}'
echo ""

# Test 7: Null profile_id with valid organization_id
echo "[TEST 7] Null profile_id with valid organization_id"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "profile_id": null,
    "organization_id": "00000000-0000-4000-8000-000000000001",
    "opportunity_data": {
      "title": "Test Org Only",
      "sponsor": "Test"
    }
  }' \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: (.id // .error), message: .message}'
echo ""

# Test 8: Expired deadline (should return 400)
echo "[TEST 8] Expired deadline (should return 400)"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "profile_id": "profile-demo-tennessee-stem-student",
    "opportunity_data": {
      "title": "Test Expired",
      "sponsor": "Test",
      "deadline": "2020-01-01"
    }
  }' \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: .error, message: .message}'
echo ""

# Test 9: Missing opportunity_id AND opportunity_data
echo "[TEST 9] Missing opportunity_id AND opportunity_data (should return 400)"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "profile_id": "profile-demo-tennessee-stem-student"
  }' \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: .error, message: .message}'
echo ""

# Test 10: opportunity_data is an array instead of object
echo "[TEST 10] opportunity_data is array (should return 400)"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "profile_id": "profile-demo-tennessee-stem-student",
    "opportunity_data": []
  }' \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: .error, message: .message}'
echo ""

# Test 11: Whitespace-only title
echo "[TEST 11] Whitespace-only title (should return 400)"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "profile_id": "profile-demo-tennessee-stem-student",
    "opportunity_data": {
      "title": "   ",
      "sponsor": "Test"
    }
  }' \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: .error, message: .message}'
echo ""

# Test 12: Invalid request body (not JSON)
echo "[TEST 12] Invalid JSON body (should return 400)"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d 'not valid json' \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: .error, message: .message}'
echo ""

# Test 13: Extremely long title (potential overflow)
echo "[TEST 13] Extremely long title"
LONG_TITLE=$(python3 -c "print('A' * 1000)")
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"profile_id\": \"profile-demo-tennessee-stem-student\",
    \"opportunity_data\": {
      \"title\": \"$LONG_TITLE\",
      \"sponsor\": \"Test\"
    }
  }" \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: (.id // .error), titleLength: (.title // "" | length)}'
echo ""

# Test 14: Both opportunity_id and opportunity_data provided
echo "[TEST 14] Both opportunity_id and opportunity_data"
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "profile_id": "profile-demo-tennessee-stem-student",
    "opportunity_id": "some-id",
    "opportunity_data": {
      "title": "Test Both",
      "sponsor": "Test"
    }
  }' \
  "$BASE_URL/api/grants/from-opportunity" | jq -c '{status: (.id // .error), message: .message}'
echo ""

echo "========================================="
echo "All edge case tests complete"
echo "========================================="
