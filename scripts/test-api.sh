#!/bin/bash

# Test script for Jira QA Agent API

BASE_URL="http://localhost:8545"

echo "🧪 Testing Jira QA Agent API"
echo ""

# Test health endpoint
echo "1. Testing health endpoint..."
curl -s "${BASE_URL}/health" | jq .
echo ""

# Test ticket testing endpoint
echo "2. Testing ticket test endpoint..."
echo "   Enter Jira ticket ID (e.g., PROJ-123):"
read -r TICKET_ID

if [ -n "$TICKET_ID" ]; then
    RESPONSE=$(curl -s -X POST "${BASE_URL}/api/test-ticket" \
        -H "Content-Type: application/json" \
        -d "{\"ticketId\": \"$TICKET_ID\"}")
    
    echo "$RESPONSE" | jq .
    
    # Extract job ID
    JOB_ID=$(echo "$RESPONSE" | jq -r '.jobId')
    
    if [ "$JOB_ID" != "null" ]; then
        echo ""
        echo "3. Checking job status..."
        sleep 2
        curl -s "${BASE_URL}/api/job-status/${JOB_ID}" | jq .
        
        echo ""
        echo "💡 Monitor job progress with:"
        echo "   watch -n 2 \"curl -s ${BASE_URL}/api/job-status/${JOB_ID} | jq .\""
    fi
else
    echo "   Skipped"
fi

echo ""
echo "4. Listing recent jobs..."
curl -s "${BASE_URL}/api/jobs?limit=5" | jq '.jobs.completed[:3], .jobs.failed[:3]'
