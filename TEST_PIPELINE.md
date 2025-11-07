# 🧪 Testing the Complete Pipeline

## Quick Test Checklist

Use this guide to verify your complete Recall.ai → ElevenLabs pipeline is working.

---

## Prerequisites

- [ ] `.env` file exists with all keys:
  - `RECALL_API_KEY`
  - `ELEVENLABS_API_KEY`
  - `AGENT_ID`
  - `PUBLIC_URL` (your ngrok URL)
  - `PORT` (default: 3000)
- [ ] Dependencies installed (`npm install`)
- [ ] Zoom or Google Meet account for testing

---

## Step 1: Start Your Local Server

```bash
cd /Users/niwantsalunke/Downloads/UNCC/Projects/ResearchSpikes
npm start
```

**Expected Output:**
```
🚀 ========================================
   Server running on port 3000
   WebSocket servers ready at:
   🔵 ws://localhost:3000/meeting-audio-in (from webpage)
   🟢 ws://localhost:3000/agent-audio-out (to webpage)
========================================
```

✅ **Success Indicator:** Server starts without errors

---

## Step 2: Expose Server with ngrok

**In a NEW terminal:**

```bash
ngrok http 3000
```

**Expected Output:**
```
Forwarding    https://abc123.ngrok.io -> http://localhost:3000
```

**Actions:**
1. Copy the `https://` URL (e.g., `https://abc123.ngrok.io`)
2. Update `.env` file:
   ```bash
   PUBLIC_URL=https://abc123.ngrok.io
   ```
3. Restart your Node.js server (Ctrl+C and `npm start` again)

✅ **Success Indicator:** ngrok shows `Session Status: online`

---

## Step 3: Test Local Pipeline (Optional)

Before testing with Recall.ai, verify the pipeline works locally:

1. Open: http://localhost:3000/full-pipeline-test.html
2. Click "▶️ Start Full Pipeline"
3. Allow microphone access
4. Speak into your microphone
5. Wait 3-5 seconds
6. You should hear AI response through your speakers

**What to Check:**
- [ ] "Audio Sent" counter increases
- [ ] "AI Responses" counter increases
- [ ] You hear the AI speaking
- [ ] Logs show "Received AI audio response"

✅ **Success Indicator:** You hear AI voice responding to your speech

---

## Step 4: Create a Test Meeting

### Option A: Zoom Meeting
```bash
# Go to zoom.us and create a meeting
# Get the URL (e.g., https://zoom.us/j/123456789)
```

### Option B: Google Meet (Recommended)
```bash
# Go to meet.new to create instant meeting
# Get the URL (e.g., https://meet.google.com/abc-defg-hij)
```

✅ **Success Indicator:** You have a meeting URL

---

## Step 5: Send Bot to Meeting

```bash
curl -X POST http://localhost:3000/join-meeting \
  -H "Content-Type: application/json" \
  -d '{"meeting_url": "YOUR_MEETING_URL_HERE"}'
```

**Expected Response:**
```json
{
  "success": true,
  "bot_id": "ca4b978a-...",
  "message": "Bot joined the meeting successfully"
}
```

**Expected Server Logs:**
```
📞 [JOIN-MEETING] Creating bot for meeting: https://...
   Webpage URL: https://abc123.ngrok.io/agent.html
   ✅ Bot created successfully!
   Bot ID: ca4b978a-...
   
   📊 Bot Status Check #1: in_waiting_room
   📊 Bot Status Check #2: in_meeting
   ✅ Bot is now in the meeting!
```

✅ **Success Indicator:** Bot shows up in your meeting

---

## Step 6: Verify Bot Webpage

In the meeting, you should see the bot's webpage (`agent.html`).

**What to Look For:**
```
🎤 AI Agent Bot
Capturing meeting audio via getUserMedia()

Status: Connected - Full pipeline active

Audio captured: 0 chunks
Server connection: Connected ✅
Audio output queue: 0

Logs:
✅ Connecting INPUT WebSocket: wss://...
✅ INPUT WebSocket connected (for sending audio)
✅ Connecting OUTPUT WebSocket: wss://...
✅ OUTPUT WebSocket connected (for receiving AI audio)
🚀 BOTH WebSockets connected! Pipeline ready!
📝 Requesting access to meeting audio...
✅ Audio access granted
✅ AudioContext created (sampleRate: 16000Hz)
✅ Audio processing pipeline established
```

✅ **Success Indicator:** Both WebSockets show "Connected ✅"

---

## Step 7: Test the Full Pipeline

1. **Speak in the meeting:**
   - Say something like: "Hello AI, can you hear me?"
   
2. **Watch the bot's webpage:**
   - "Audio captured" should increment
   - Logs should show "Sent X audio chunks to server"

3. **Watch your server logs:**
   ```
   🔵 [WEBPAGE] Connection established from webpage
   🔊 [WEBPAGE] Received 20 audio chunks (~0.5 KB each)
   
   🎙️  Voice detected - connecting to ElevenLabs...
   🟣 [ELEVENLABS] Connected to ElevenLabs API
   🟣 [ELEVENLABS] Message type: conversation_initiation_metadata
      ✅ Conversation initialized with ElevenLabs!
   
   🟣 [ELEVENLABS] Message type: user_transcript
      👤 User said: "Hello AI, can you hear me?"
   
   🟣 [ELEVENLABS] Message type: agent_response
      🤖 Agent responding...
   
   🟣 [ELEVENLABS] Message type: audio
      🎵 Audio response received (~15.2 KB)
      📤 Broadcasting to 1 frontend client(s)
   ```

4. **Watch the bot's webpage logs:**
   ```
   🎵 Received AI audio response (~15.2 KB)
   🔊 Playing AI response in meeting...
   ▶️ Playing 2.45s of AI audio in meeting
   ✅ AI audio playback finished
   ```

5. **Listen in the meeting:**
   - You should HEAR the AI speaking
   - Other participants should also hear it

✅ **Success Indicator:** AI voice plays audibly in the meeting

---

## Step 8: Verify Complete Flow

**The complete flow should be:**

```
YOU SPEAK
   ↓
Browser captures audio (getUserMedia)
   ↓
Sent to server via /meeting-audio-in WebSocket
   ↓
Server forwards to ElevenLabs
   ↓
ElevenLabs transcribes: "Hello AI..."
   ↓
ElevenLabs AI processes
   ↓
ElevenLabs generates voice response
   ↓
Server receives audio via ElevenLabs WebSocket
   ↓
Server broadcasts to /agent-audio-out WebSocket
   ↓
Browser receives and plays audio
   ↓
AI VOICE PLAYS IN MEETING
```

---

## Common Issues & Solutions

### Issue: Bot joins but no audio chunks sent

**Check:**
```
1. Open browser dev tools on bot's webpage
2. Check console for errors
3. Verify getUserMedia permission granted
4. Check if "Audio captured" counter increases
```

**Solution:**
- Ensure bot has microphone permissions in meeting
- Check browser console for getUserMedia errors
- Verify meeting participants are speaking

### Issue: Audio chunks sent but no ElevenLabs response

**Check Server Logs:**
```
🟣 [ELEVENLABS] Connected to ElevenLabs API
✅ Conversation initialized with ElevenLabs!
```

**If not connected:**
- Verify `ELEVENLABS_API_KEY` in `.env`
- Verify `AGENT_ID` in `.env`
- Check ElevenLabs quota: https://elevenlabs.io/app/usage

### Issue: AI responds but no audio plays

**Check:**
```
📤 Broadcasting: X sent, 0 failed, 0 not ready
```

**If 0 sent:**
- Verify OUTPUT WebSocket connected in agent.html
- Check browser console for errors
- Look for "OUTPUT WebSocket connected" message

### Issue: Audio plays but sounds garbled

**Check:**
- Sample rate mismatch (should be 24kHz from ElevenLabs)
- Audio format detection (check server logs for "Audio header bytes")
- Volume too low (check gain node in playback code)

---

## Health Check Endpoint

Test your server connectivity:

```bash
curl http://localhost:3000/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "connections": 1,
  "webpage_connections": 1,
  "agent_connections": 1
}
```

---

## Debugging Commands

### Check if server is running
```bash
lsof -i :3000
```

### Check WebSocket connections
```bash
curl http://localhost:3000/test
```

### Monitor server logs with timestamps
```bash
npm start | ts '[%Y-%m-%d %H:%M:%S]'
```

### Check ElevenLabs API status
```bash
curl -H "xi-api-key: YOUR_API_KEY" \
  https://api.elevenlabs.io/v1/user
```

---

## Success Metrics

When everything works, you should see:

### In Meeting
- ✅ Bot joins successfully
- ✅ Bot webpage shows "Connected"
- ✅ Audio chunks counter increases when speaking
- ✅ AI voice plays audibly
- ✅ Other participants hear AI

### In Server Logs
- ✅ Webpage connections: 1+
- ✅ Agent connections: 1+
- ✅ Audio chunks flowing
- ✅ ElevenLabs conversation active
- ✅ Audio responses broadcasting

### In Browser Console
- ✅ No errors
- ✅ Both WebSockets connected
- ✅ Audio capture active
- ✅ AI responses playing

---

## Performance Benchmarks

**Expected Latency:**
- Audio capture → Server: < 100ms
- Server → ElevenLabs: < 200ms
- ElevenLabs processing: 1-3 seconds
- Total response time: 2-5 seconds

**Expected Throughput:**
- Audio chunk size: ~0.5 KB
- Chunks per second: ~4 (at 16kHz, 4096 samples)
- Bandwidth: ~2 KB/s upstream

---

## Next Steps After Success

1. **Optimize Latency:**
   - Reduce chunk size for faster transmission
   - Use ElevenLabs streaming mode
   - Implement audio buffering

2. **Add Features:**
   - Interruption handling
   - Context persistence
   - Multi-participant support

3. **Monitor Production:**
   - Set up logging/monitoring
   - Track ElevenLabs quota
   - Monitor WebSocket stability

4. **Scale:**
   - Load balancing
   - Multiple concurrent meetings
   - Geographic distribution

---

## Support Resources

- **Recall.ai Docs:** https://docs.recall.ai/
- **ElevenLabs Docs:** https://elevenlabs.io/docs/agents-platform/libraries/web-sockets
- **Your Pipeline Docs:** See `RECALL_AI_PIPELINE.md`

---

**Happy Testing! 🚀**

If all tests pass, your AI meeting agent is fully operational!




