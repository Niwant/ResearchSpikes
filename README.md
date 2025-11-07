# Real-Time AI Agent for Zoom/Google Meet Meetings

A production-ready Node.js application that creates an AI agent capable of joining meetings in real-time, listening to conversations, and responding with AI-generated speech using **Recall.ai** and **ElevenLabs**.

## 🎯 Features

- ✅ **Real-time audio capture** from meetings via Recall.ai WebSocket
- ✅ **AI-powered responses** using ElevenLabs conversational AI
- ✅ **Clear audio output** via ultra-minimal webpage (no jitter)
- ✅ **Works with Zoom, Google Meet, Microsoft Teams, and more**
- ✅ **Low latency** bidirectional audio streaming
- ✅ **Production-ready** with error handling and reconnection logic

## 🏗️ Architecture

### Complete Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Meeting Platform                          │
│              (Zoom / Google Meet / Teams)                    │
│                                                              │
│  Participants speak → Meeting audio captured                │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│              Recall.ai Bot (in meeting)                      │
│                                                              │
│  1. Bot joins meeting via Recall.ai API                      │
│  2. Captures meeting audio (built-in)                        │
│  3. Sends audio via WebSocket → Your Server                  │
│  4. Loads agent-minimal.html (ultra-minimal webpage)         │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        │ WebSocket: audio_mixed_raw.data
                        │ Format: 16kHz mono S16LE PCM (base64)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│              Your Node.js Server (index.js)                  │
│                                                              │
│  WebSocket: /recall-audio-in                                 │
│    ↓                                                         │
│  Receives audio from Recall.ai                               │
│    ↓                                                         │
│  Forwards to ElevenLabs WebSocket                            │
│    ↓                                                         │
│  Receives AI response from ElevenLabs                        │
│    ↓                                                         │
│  Broadcasts to /agent-audio-out                              │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        │ WebSocket: { type: "audio", data: base64 }
                        │ Format: 16kHz mono PCM (base64)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│         agent-minimal.html (in bot's webpage)                │
│                                                              │
│  - Ultra-minimal (black screen, audio only)                  │
│  - Receives AI audio via WebSocket                           │
│  - Converts PCM to Web Audio API                             │
│  - Plays audio in meeting (3x volume boost)                  │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                    Meeting Platform                          │
│                                                              │
│  AI voice plays → All participants hear AI response          │
└─────────────────────────────────────────────────────────────┘
```

### Component Details

**1. Recall.ai Bot**
- Joins meeting via API
- Captures meeting audio automatically
- Streams audio to your server via WebSocket
- Loads minimal webpage for audio output

**2. Your Server (Node.js)**
- Receives audio from Recall.ai (`/recall-audio-in`)
- Forwards to ElevenLabs WebSocket API
- Receives AI responses from ElevenLabs
- Broadcasts to webpage (`/agent-audio-out`)

**3. ElevenLabs AI**
- Processes incoming audio
- Transcribes speech
- Generates contextual responses
- Synthesizes voice (16kHz PCM)

**4. agent-minimal.html**
- Ultra-minimal webpage (black screen)
- Receives AI audio via WebSocket
- Plays audio in meeting
- Low bandwidth = clear audio quality

## 📋 Prerequisites

- **Node.js** 16+ installed
- **ngrok** account for tunneling (free tier works)
- **Recall.ai** API key ([Get one here](https://recall.ai))
- **ElevenLabs** account with:
  - API key ([Get one here](https://elevenlabs.io))
  - Agent ID (create a conversational agent)

## 🚀 Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Recall.ai
RECALL_API_KEY=Token_your_actual_recall_key
PUBLIC_URL=https://your-actual-ngrok-url.ngrok.io

# ElevenLabs
ELEVENLABS_API_KEY=your_actual_elevenlabs_key
AGENT_ID=your_actual_agent_id

# Server
PORT=8000
```

### 3. Start Local Server

```bash
npm start
```

The server will run on `http://localhost:8000` (or your configured PORT).

### 4. Expose with ngrok

In a **separate terminal**, start ngrok:

```bash
ngrok http 8000
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`) and update your `.env` file:

```env
PUBLIC_URL=https://abc123.ngrok.io
```

**Important:** Restart the Node.js server after updating `PUBLIC_URL`:

```bash
# Press Ctrl+C to stop, then:
npm start
```

### 5. Join a Meeting

Use the provided script:

```bash
./test-bot.sh "https://zoom.us/j/123456789"
```

Or use curl:

```bash
curl -X POST http://localhost:8000/join-meeting \
  -H "Content-Type: application/json" \
  -d '{"meeting_url": "https://zoom.us/j/123456789"}'
```

**Supported Platforms:**
- ✅ Zoom
- ✅ Google Meet
- ✅ Microsoft Teams
- ✅ Cisco Webex

## 🔄 How It Works

### 1. Bot Creation & Join Flow

1. **POST `/join-meeting`** receives meeting URL
2. Server calls Recall.ai API to create bot with:
   - `recording_config.realtime_endpoints` → WebSocket for audio input
   - `output_media.camera.config.url` → Webpage for audio output
   - `automatic_audio_output` → Enables audio capability
3. Bot joins meeting automatically
4. Bot loads `agent-minimal.html` webpage

### 2. Audio Input Flow (Meeting → ElevenLabs)

```
Meeting Audio
    ↓
Recall.ai captures (built-in)
    ↓
WebSocket: wss://your-server/recall-audio-in
    ↓
Server receives: { event: "audio_mixed_raw.data", data: { data: { buffer: base64 } } }
    ↓
Extract base64 audio buffer
    ↓
Forward to ElevenLabs: { user_audio_chunk: base64 }
    ↓
ElevenLabs processes & generates response
```

**Audio Format:**
- Input: 16kHz mono S16LE PCM (base64 encoded)
- From: Recall.ai WebSocket
- To: ElevenLabs WebSocket

### 3. Audio Output Flow (ElevenLabs → Meeting)

```
ElevenLabs generates response
    ↓
WebSocket: { type: "audio", audio_event: { audio_base_64: base64 } }
    ↓
Server receives & broadcasts
    ↓
WebSocket: wss://your-server/agent-audio-out
    ↓
agent-minimal.html receives: { type: "audio", data: base64 }
    ↓
Decode base64 → PCM samples
    ↓
Web Audio API → Plays in meeting
```

**Audio Format:**
- Output: 16kHz mono PCM (base64 encoded)
- From: ElevenLabs WebSocket
- To: agent-minimal.html → Meeting

## 📁 Project Structure

```
.
├── index.js                    # Main server (Express + WebSocket handlers)
├── package.json                # Dependencies
├── .env                        # Environment variables (not in git)
├── .env.example                # Environment template
├── test-bot.sh                 # Quick bot deployment script
├── README.md                   # This file
└── public/
    ├── agent-minimal.html      # Ultra-minimal audio player (PRODUCTION)
    ├── agent-simple.html       # Simple audio player (backup)
    ├── agent.html              # Full-featured player (with UI)
    ├── full-pipeline-test.html # Local testing tool
    └── diagnose.html           # Audio diagnostics tool
```

## 🔌 API Endpoints

### POST /join-meeting

Creates a bot and joins a meeting.

**Request:**
```json
{
  "meeting_url": "https://zoom.us/j/123456789"
}
```

**Response:**
```json
{
  "success": true,
  "bot_id": "872dc101-4660-4020-ad77-baddf6f34fe2",
  "message": "Bot joined the meeting successfully"
}
```

### WebSocket /recall-audio-in

Receives real-time audio from Recall.ai bot.

**Connection:** Automatic (Recall.ai connects when bot joins)

**Message Format:**
```json
{
  "event": "audio_mixed_raw.data",
  "data": {
    "data": {
      "buffer": "base64-encoded-pcm-audio",
      "timestamp": {
        "relative": 0.5,
        "absolute": "2025-10-28T21:08:38Z"
      }
    },
    "recording": { "id": "..." },
    "bot": { "id": "..." }
  }
}
```

**Audio Format:** 16kHz mono S16LE PCM (base64)

### WebSocket /agent-audio-out

Sends AI audio to the bot's webpage for playback.

**Connection:** agent-minimal.html connects automatically

**Message Format:**
```json
{
  "type": "audio",
  "data": "base64-encoded-pcm-audio",
  "timestamp": 1234567890
}
```

**Audio Format:** 16kHz mono PCM (base64)

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "connections": 1,
  "webpage_connections": 0,
  "agent_connections": 1
}
```

### GET /test

Test endpoint showing server configuration.

## 🔧 Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `RECALL_API_KEY` | Your Recall.ai API token | `Token abc123...` |
| `ELEVENLABS_API_KEY` | Your ElevenLabs API key | `sk-abc123...` |
| `AGENT_ID` | ElevenLabs Agent ID | `agent_8801k8mgyrxpfxeb2sxdr7fsvjdm` |
| `PORT` | Local server port | `8000` |
| `PUBLIC_URL` | Your ngrok HTTPS URL | `https://abc123.ngrok.io` |

## 🐛 Troubleshooting

### Bot joins but no audio is captured

**Check:**
1. Server logs should show: `🟣 [RECALL.AI] Audio stream connected`
2. Look for: `🟣 [RECALL.AI] First audio packet received!`
3. Verify participants are speaking and unmuted
4. Check Recall.ai dashboard for bot status

**Solution:**
- Ensure meeting has active audio
- Verify `recording_config.realtime_endpoints` is in bot config
- Check WebSocket connection in server logs

### Multiple ElevenLabs connections (capacity error)

**Symptoms:**
- Logs show many "Connecting to ElevenLabs..." messages
- Error: "Agent at max concurrent connections" (code 4300)

**Solution:**
- ✅ Fixed with `isConnecting` flag (prevents duplicate connections)
- Restart server to apply fix
- Should see only ONE connection attempt

### Audio is unclear or jittery

**Symptoms:**
- AI voice is choppy or unclear
- Network jitter in audio

**Solution:**
- ✅ Fixed with `agent-minimal.html` (ultra-minimal webpage)
- Black screen = low bandwidth = clear audio
- If still issues, check network connection

### Webpage doesn't load in bot

**Check:**
1. Bot config should have: `output_media.camera.config.url`
2. Verify `PUBLIC_URL` is correct in `.env`
3. Check ngrok is running and accessible

**Solution:**
- Ensure `output_media` structure is correct (see code)
- Verify webpage URL is accessible via HTTPS
- Check bot status in Recall.ai dashboard

### ElevenLabs quota exceeded

**Symptoms:**
- Error: "This request exceeds your quota limit" (code 1002)
- Connections close immediately

**Solution:**
- Check quota: https://elevenlabs.io/app/usage
- Upgrade plan if needed
- Wait for quota reset

### Bot doesn't join meeting

**Check:**
- Verify `RECALL_API_KEY` is correct
- Ensure meeting URL format is valid
- Check ngrok is running
- Verify `PUBLIC_URL` matches ngrok URL

**Solution:**
- Test with Google Meet first (most reliable)
- Check Recall.ai API status
- Verify bot permissions in meeting platform

## 🧪 Testing

### Local Pipeline Test

Test the complete pipeline locally (without Recall.ai):

1. Open: `http://localhost:8000/full-pipeline-test.html`
2. Click "Start Full Pipeline"
3. Speak into microphone
4. Should hear AI response

### Full Integration Test

1. Start server: `npm start`
2. Start ngrok: `ngrok http 8000`
3. Update `.env` with ngrok URL
4. Restart server
5. Join meeting: `./test-bot.sh "MEETING_URL"`
6. Speak in meeting
7. Should hear AI response within 3-5 seconds

### Expected Logs

**Successful flow:**
```
🟣 [RECALL.AI] Audio stream connected from Recall.ai bot
🟣 [RECALL.AI] First audio packet received!
   Format: 16kHz mono S16LE (16-bit PCM)

🎙️  Audio from Recall.ai - connecting to ElevenLabs...
🟣 [ELEVENLABS] Connected to ElevenLabs API
✅ Conversation initialized with ElevenLabs!

👤 User said: "Hello AI"
🤖 Agent responding...
🎵 Audio response received (~117 KB)
📤 Broadcasting: 1 sent, 0 failed, 0 not ready
```

## 🔐 Security Notes

- ✅ Never commit `.env` file to version control
- ✅ Keep API keys secure
- ✅ Use HTTPS in production (ngrok provides this)
- ✅ Validate meeting URLs before processing
- ⚠️ Consider rate limiting for production
- ⚠️ Add authentication for public endpoints

## 📊 Performance

**Expected Latency:**
- Audio capture → Server: < 100ms
- Server → ElevenLabs: < 200ms
- ElevenLabs processing: 1-3 seconds
- **Total response time: 2-5 seconds**

**Bandwidth:**
- Audio input: ~2 KB/s (upstream)
- Audio output: ~8 KB/s (burst, downstream)
- Webpage: Minimal (black screen only)

## 🚀 Production Deployment

### Recommended Setup

1. **Use a VPS/Cloud Server** (not local machine)
2. **Set up proper domain** (not ngrok)
3. **Use PM2** for process management:
   ```bash
   npm install -g pm2
   pm2 start index.js --name ai-agent
   ```
4. **Set up SSL** (Let's Encrypt)
5. **Monitor logs** and errors
6. **Set up alerts** for quota limits

### Scaling

- Handle multiple concurrent meetings
- Use connection pooling
- Monitor ElevenLabs quota
- Implement rate limiting

## 📚 Documentation

- **Recall.ai Docs:** https://docs.recall.ai/docs/real-time-audio-protocol
- **ElevenLabs Docs:** https://elevenlabs.io/docs/agents-platform/libraries/web-sockets
- **Web Audio API:** https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API

## 🎉 Success Indicators

When everything works correctly:

✅ Bot joins meeting within 30 seconds  
✅ Server logs show Recall.ai connection  
✅ Server logs show ElevenLabs connection  
✅ You speak → AI responds within 3-5 seconds  
✅ AI voice is clear and audible  
✅ Other participants hear AI responses  

## 📝 License

MIT

## 🙏 Support

For issues with:
- **Recall.ai**: Check their [documentation](https://docs.recall.ai) or [support](https://recall.ai/support)
- **ElevenLabs**: Check their [documentation](https://elevenlabs.io/docs) or [support](https://elevenlabs.io/support)
- **This Project**: Review troubleshooting section above

---

**Built with:** Node.js, Express, WebSockets, Recall.ai, ElevenLabs  
**Status:** ✅ Production Ready  
**Last Updated:** October 2025
