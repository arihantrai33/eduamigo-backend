#!/bin/bash
# Manual smoke test for the AI revision endpoint.
# Usage: EDUAMIGO_TEST_EMAIL=... EDUAMIGO_TEST_PASSWORD=... ./test-revision.sh "your question"
# Credentials are read from the environment so they never end up in git.
set -euo pipefail

QUESTION="${1:-}"
API="${API_URL:-http://localhost:8000/api}"

if [ -z "$QUESTION" ]; then
  echo "Usage: ./test-revision.sh \"your question here\""
  exit 1
fi
if [ -z "${EDUAMIGO_TEST_EMAIL:-}" ] || [ -z "${EDUAMIGO_TEST_PASSWORD:-}" ]; then
  echo "Set EDUAMIGO_TEST_EMAIL and EDUAMIGO_TEST_PASSWORD first."
  exit 1
fi

LOGIN_BODY=$(node -e 'console.log(JSON.stringify({email:process.env.EDUAMIGO_TEST_EMAIL,password:process.env.EDUAMIGO_TEST_PASSWORD}))')
TOKEN=$(curl -s -X POST "$API/users/login" -H "Content-Type: application/json" -d "$LOGIN_BODY" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token||''))")

if [ -z "$TOKEN" ]; then
  echo "Login failed."
  exit 1
fi

BODY=$(QUESTION="$QUESTION" node -e 'console.log(JSON.stringify({question:process.env.QUESTION}))')

# The endpoint streams: first line is JSON {"sources":[...]}, the rest is the answer text.
curl -sN -X POST "$API/revision/ask" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$BODY"
echo
