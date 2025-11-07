#!/bin/bash

# Test Bot Script - Quickly join a meeting with your AI bot

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🤖 AI Bot Deployment Script${NC}"
echo "================================"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${RED}❌ Error: .env file not found${NC}"
    echo "Please create a .env file with your API keys"
    exit 1
fi

# Check if server is running
if ! lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo -e "${YELLOW}⚠️  Server not running on port 3000${NC}"
    echo "Please start the server first:"
    echo "  npm start"
    exit 1
fi

echo -e "${GREEN}✅ Server is running${NC}"

# Get meeting URL from user
if [ -z "$1" ]; then
    echo ""
    echo "Usage: ./test-bot.sh <meeting_url>"
    echo ""
    echo "Example:"
    echo "  ./test-bot.sh https://zoom.us/j/123456789"
    echo "  ./test-bot.sh https://meet.google.com/abc-defg-hij"
    exit 1
fi

MEETING_URL="$1"

echo -e "${BLUE}📞 Joining meeting:${NC} $MEETING_URL"
echo ""

# Make API call
RESPONSE=$(curl -s -X POST http://localhost:3000/join-meeting \
  -H "Content-Type: application/json" \
  -d "{\"meeting_url\": \"$MEETING_URL\"}")

# Check if successful
if echo "$RESPONSE" | grep -q "\"success\":true"; then
    BOT_ID=$(echo "$RESPONSE" | grep -o '"bot_id":"[^"]*"' | cut -d'"' -f4)
    echo -e "${GREEN}✅ Success! Bot joined the meeting${NC}"
    echo ""
    echo -e "${BLUE}Bot ID:${NC} $BOT_ID"
    echo ""
    echo -e "${YELLOW}📊 View bot status:${NC}"
    echo "https://us-west-2.recall.ai/dashboard/explorer/bot/$BOT_ID"
    echo ""
    echo -e "${GREEN}🎯 What to expect:${NC}"
    echo "1. Bot should appear in your meeting within 10-30 seconds"
    echo "2. You'll see the agent.html webpage in the meeting"
    echo "3. Speak into your microphone"
    echo "4. Wait 3-5 seconds for AI response"
    echo "5. AI voice should play through the bot"
    echo ""
    echo -e "${BLUE}💡 Monitor server logs for real-time status${NC}"
else
    echo -e "${RED}❌ Failed to join meeting${NC}"
    echo ""
    echo "Response:"
    echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
    echo ""
    echo "Common issues:"
    echo "- Invalid meeting URL"
    echo "- Recall.ai API key not set"
    echo "- PUBLIC_URL not configured in .env"
    exit 1
fi

