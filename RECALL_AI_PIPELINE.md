# 🚀 Complete Recall.ai → ElevenLabs AI Pipeline

## 📊 Architecture Overview

```
┌─────────────────┐
│  Zoom Meeting   │
│   Participant   │
└────────┬────────┘
         │ speaks
         ▼
┌─────────────────────────────────────────────────────────────┐
│               Recall.ai Bot (in meeting)                    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  agent.html (webpage running in bot)                 │  │
│  │                                                       │  │
│  │  1. getUserMedia() captures meeting audio            │  │
│  │  2. Converts to PCM 16-bit, 16kHz                    │  │
│  │  3. Sends via WebSocket (wsInput)                    │  │
│  │     → wss://your-server.ngrok.io/meeting-audio-in   │  │
│  │                                                       │  │
│  │  4. Receives AI audio via WebSocket (wsOutput)       │  │
│  │     ← wss://your-server.ngrok.io/agent-audio-out    │  │
│  │  5. Plays AI response in meeting                     │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │                                        ▲
         │ PCM audio                              │ PCM audio
         │ (base64)                               │ (base64)
         ▼                                        │
┌─────────────────────────────────────────────────────────────┐
│               Your Node.js Server (index.js)                │
│                                                              │
│  WebSocket /meeting-audio-in     WebSocket /agent-audio-out│
│        │                                        ▲            │
│        │                                        │            │
│        └───► Forward audio to ElevenLabs ──────┘            │
│              (format: { user_audio_chunk })                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                        │                ▲
                        │                │
                        ▼                │
              ┌──────────────────────────────┐
              │   ElevenLabs AI Agent API    │
              │                              │
              │  1. Transcribes audio        │
              │  2. Processes with AI        │
              │  3. Generates voice response │
              │  4. Sends back PCM audio     │
              └──────────────────────────────┘
```

---

## 🔄 Complete Data Flow

### Step 1: Bot Joins Meeting
```bash
# Make API call to create bot
curl -X POST http://localhost:3000/join-meeting \
  -H "Content-Type: application/json" \
  -d '{"meeting_url": "https://zoom.us/j/YOUR_MEETING_ID"}'
```

**What happens:**
1. Server calls Recall.ai API to create bot
2. Bot joins the Zoom meeting
3. Bot loads `agent.html` webpage
4. Webpage is visible in the meeting

### Step 2: WebSocket Connections Established

**agent.html connects to TWO WebSockets:**

#### A. Input WebSocket (Sending Audio)
- **URL:** `wss://your-server.ngrok.io/meeting-audio-in`
- **Purpose:** Send meeting audio TO server
- **Data format:**
```json
{
  "type": "audio_chunk",
  "data": "base64_encoded_pcm_audio",
  "format": "pcm16",
  "sampleRate": 16000
}
```

#### B. Output WebSocket (Receiving Audio)
- **URL:** `wss://your-server.ngrok.io/agent-audio-out`
- **Purpose:** Receive AI audio FROM server
- **Data format:**
```json
{
  "type": "audio",
  "data": "base64_encoded_pcm_audio"
}
```

### Step 3: Audio Capture (agent.html)

```javascript
// 1. getUserMedia() captures meeting audio
const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

// 2. AudioContext processes at 16kHz
const audioContext = new AudioContext({ sampleRate: 16000 });

// 3. ScriptProcessorNode processes 4096-sample chunks
processor.onaudioprocess = (event) => {
  const inputData = event.inputBuffer.getChannelData(0); // Float32
  
  // Convert to PCM 16-bit
  const pcmData = new Int16Array(inputData.length);
  for (let i = 0; i < inputData.length; i++) {
    const s = Math.max(-1, Math.min(1, inputData[i]));
    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  
  // Convert to base64 and send
  const base64Audio = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
  wsInput.send(JSON.stringify({ type: 'audio_chunk', data: base64Audio }));
};
```

### Step 4: Server Receives & Forwards (index.js)

```javascript
// Server receives from agent.html
meetingAudioInServer.on('connection', (ws) => {
  ws.on('message', async (data) => {
    const message = JSON.parse(data);
    
    if (message.type === 'audio_chunk') {
      // Create ElevenLabs connection (if not exists)
      const elevenlabsWs = await createElevenLabsConnection();
      
      // Forward to ElevenLabs (correct format!)
      elevenlabsWs.send(JSON.stringify({
        user_audio_chunk: message.data  // Just base64 string
      }));
    }
  });
});
```

### Step 5: ElevenLabs Processes

**ElevenLabs WebSocket URL:**
```
wss://api.elevenlabs.io/v1/convai/conversation?agent_id=YOUR_AGENT_ID
```

**Headers:**
```javascript
{
  'xi-api-key': 'YOUR_API_KEY'
}
```

**Events from ElevenLabs:**
1. `conversation_initiation_metadata` - Connection ready
2. `user_transcript` - What user said (transcription)
3. `agent_response` - AI is responding
4. `audio` - AI voice response (PCM 24kHz base64)
5. `ping` - Keep connection alive (respond with `pong`)

### Step 6: Server Broadcasts AI Response

```javascript
// Server receives audio from ElevenLabs
elevenlabsWs.on('message', (data) => {
  const message = JSON.parse(data);
  
  if (message.type === 'audio' && message.audio_event) {
    const audioData = message.audio_event.audio_base_64;
    
    // Broadcast to ALL connected agent-audio-out clients
    audioOutClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'audio',
          data: audioData
        }));
      }
    });
  }
});
```

### Step 7: Agent Plays Audio (agent.html)

```javascript
// Receive AI audio
wsOutput.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  if (message.type === 'audio') {
    audioOutputQueue.push(message.data);
    playNextAudioOutput();
  }
};

// Play audio in meeting
async function playNextAudioOutput() {
  const base64Audio = audioOutputQueue.shift();
  
  // Decode base64
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  // Convert to Int16 PCM samples
  const pcmSamples = new Int16Array(bytes.buffer);
  
  // Create Web Audio API buffer (24kHz from ElevenLabs)
  const playbackContext = new AudioContext();
  const audioBuffer = playbackContext.createBuffer(1, pcmSamples.length, 24000);
  
  // Convert to Float32
  const channelData = audioBuffer.getChannelData(0);
  for (let i = 0; i < pcmSamples.length; i++) {
    channelData[i] = pcmSamples[i] / 32768.0;
  }
  
  // Play through speakers in meeting
  const source = playbackContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(playbackContext.destination);
  source.start(0);
}
```

---

## 🎯 Audio Format Details

### Input Audio (Meeting → Server → ElevenLabs)
- **Source:** `getUserMedia()` from meeting
- **Processing:** `AudioContext` at 16kHz
- **Format:** PCM 16-bit mono
- **Chunk size:** 4096 samples (~256ms at 16kHz)
- **Transport:** Base64 encoded via WebSocket
- **To ElevenLabs:** `{ user_audio_chunk: base64String }`

### Output Audio (ElevenLabs → Server → Meeting)
- **Source:** ElevenLabs AI voice synthesis
- **Format:** PCM 16-bit mono at 24kHz
- **Transport:** Base64 encoded via WebSocket
- **Playback:** Web Audio API `AudioBuffer`

---

## 🛠️ Setup & Deployment

### 1. Environment Variables (.env)

```bash
# Recall.ai
RECALL_API_KEY=your_recall_api_key
PUBLIC_URL=https://your-domain.ngrok.io

# ElevenLabs
ELEVENLABS_API_KEY=your_elevenlabs_api_key
AGENT_ID=your_elevenlabs_agent_id

# Server
PORT=3000
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start Server

```bash
npm start
```

### 4. Expose with ngrok

```bash
ngrok http 3000
```

Copy the ngrok URL (e.g., `https://abc123.ngrok.io`) and update `PUBLIC_URL` in `.env`.

### 5. Join a Meeting

```bash
curl -X POST http://localhost:3000/join-meeting \
  -H "Content-Type: application/json" \
  -d '{"meeting_url": "https://zoom.us/j/123456789"}'
```

---

## 📝 Server Logs Explained

### Successful Pipeline Flow

```
🔵 [WEBPAGE] Connection established from webpage
   Active webpage connections: 1

🔊 [WEBPAGE] Received 20 audio chunks (~0.5 KB each)

   🎙️  Voice detected - connecting to ElevenLabs...

🟣 [ELEVENLABS] Connected to ElevenLabs API
   Agent ID passed in URL: your_agent_id

🟣 [ELEVENLABS] Message type: conversation_initiation_metadata
   ✅ Conversation initialized with ElevenLabs!

🟣 [ELEVENLABS] Message type: user_transcript
   👤 User said: "Hello AI, how are you?"

🟣 [ELEVENLABS] Message type: agent_response
   🤖 Agent responding...

🟣 [ELEVENLABS] Message type: audio
   🎵 Audio response received (~15.2 KB)
   📤 Broadcasting to 1 frontend client(s)
```

---

## 🚨 Troubleshooting

### No audio chunks received from webpage

**Check:**
1. Is bot visible in the meeting?
2. Open browser dev tools on the bot's webpage
3. Check for getUserMedia errors
4. Verify microphone permissions

**Logs to look for:**
```
🔵 [WEBPAGE] Connection established from webpage
📝 Audio access granted
📝 AudioContext created (sampleRate: 16000Hz)
```

### ElevenLabs connection closes immediately

**Check:**
1. API key is correct
2. Agent ID is correct
3. ElevenLabs quota not exceeded

**Logs to look for:**
```
❌ [ELEVENLABS] Close code: 1008 - Policy violation
```

### AI audio not playing in meeting

**Check:**
1. Both WebSockets connected (input AND output)
2. Audio format conversion is correct (24kHz PCM)
3. Browser autoplay policy

**Logs to look for:**
```
✅ OUTPUT WebSocket connected (for receiving AI audio)
🎵 Received AI audio response (~15.2 KB)
🔊 Playing AI response in meeting...
```

---

## 🔐 Security Notes

1. **Never commit `.env`** - Contains API keys
2. **Use HTTPS** - ngrok provides this automatically
3. **Validate input** - Server should validate all WebSocket messages
4. **Rate limiting** - Consider rate limiting API calls
5. **Quota monitoring** - Monitor ElevenLabs usage

---

## 📚 API References

- **Recall.ai Docs:** https://docs.recall.ai/
- **ElevenLabs WebSocket:** https://elevenlabs.io/docs/agents-platform/libraries/web-sockets
- **Web Audio API:** https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API

---

## ✅ Testing Checklist

- [ ] Server starts without errors
- [ ] ngrok tunnel is active
- [ ] Bot successfully joins meeting
- [ ] agent.html loads in meeting
- [ ] Both WebSockets connect (input & output)
- [ ] Audio chunks are sent to server
- [ ] ElevenLabs connection established
- [ ] User speech is transcribed
- [ ] AI generates response
- [ ] AI audio plays in meeting
- [ ] Other participants hear AI response

---

## 🎉 Success Indicators

When everything is working, you should see:

1. **In Meeting:**
   - Bot joins with agent.html visible
   - When you speak, you see audio chunks counting up
   - AI responds audibly in the meeting
   - Other participants hear the AI

2. **In Server Logs:**
   - Webpage connections established
   - Audio chunks flowing
   - ElevenLabs conversation active
   - Audio responses broadcasting

3. **In Browser Console:**
   - Both WebSockets connected
   - Audio capture active
   - AI responses queued and playing

---

## 🚀 Next Steps

1. **Improve latency** - Optimize chunk sizes
2. **Add interruption handling** - Handle users talking over AI
3. **Better error recovery** - Auto-reconnect on failures
4. **Monitor quota** - Track ElevenLabs API usage
5. **Scale** - Handle multiple concurrent meetings

---

**Pipeline Status: ✅ Complete & Ready to Test!**




