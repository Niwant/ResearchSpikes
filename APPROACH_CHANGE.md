# 🎯 New Approach: getUserMedia() Direct Audio Capture

## ✅ What Changed

We've switched from Recall.ai's **real-time WebSocket protocol** to the **webpage `getUserMedia()` approach** for audio capture.

---

## 🔄 Old Approach (Had Issues)

```
Recall.ai → WebSocket Events → Your Server → ElevenLabs
```

**Problems:**
- WebSocket connected but immediately disconnected (code 1006)
- No audio events were received despite bot recording
- Consistent failure across both `audio_mixed_raw` and `audio_separate_raw`

---

## 🚀 New Approach (Recommended by Recall.ai Docs)

```
Meeting Audio → Webpage getUserMedia() → WebSocket → Your Server → ElevenLabs
                                                              ↓
                                                         AI Response
                                                              ↓
                                                Webpage Audio Playback
```

### How It Works:

1. **Bot joins meeting** with a webpage (`agent.html`)
2. **Webpage captures audio** using `navigator.mediaDevices.getUserMedia()`
3. **Audio is processed** in the browser (converted to PCM 16-bit)
4. **Chunks sent via WebSocket** to `/meeting-audio-in` on your server
5. **Server forwards to ElevenLabs** for AI processing
6. **AI responses sent back** to webpage via `/agent-audio-out`
7. **Webpage plays AI audio** in the meeting

---

## 📁 Files Changed

### `public/agent.html`
- ✅ Now captures meeting audio via `getUserMedia()`
- ✅ Processes audio to PCM 16-bit at 16kHz
- ✅ Sends chunks to server every 4096 samples
- ✅ Still receives and plays AI audio responses
- ✅ Shows real-time stats: chunks sent, queue size, connection status

### `index.js`
- ✅ Renamed WebSocket: `/recall-audio-in` → `/meeting-audio-in`
- ✅ Simplified bot config (no `realtime_endpoints` or `recording_config`)
- ✅ Handles audio from webpage instead of Recall.ai
- ✅ Still forwards to ElevenLabs and broadcasts responses

---

## 🧪 Testing

### 1. Join a meeting:
```bash
curl -X POST http://localhost:3000/join-meeting \
  -H "Content-Type: application/json" \
  -d '{"meeting_url": "YOUR_MEETING_URL"}'
```

### 2. Watch for these logs:

#### ✅ Successful Flow:
```
📞 [JOIN-MEETING] Creating bot for meeting: https://...
✅ Bot created successfully!
🔵 [WEBPAGE] Connection established from webpage
🔊 [WEBPAGE] Received 20 audio chunks (~0.5 KB each)
⏳ Creating new ElevenLabs connection...
🟣 [ELEVENLABS] Connected to ElevenLabs API
✅ Conversation initialized with ElevenLabs
🎵 Audio response received (~15.2 KB)
📤 Broadcasting to 1 frontend client(s)
```

### 3. Check the webpage

Open your bot in the meeting - you should see:
- ✅ "Connected - Capturing audio from meeting 🎙️"
- ✅ Audio chunks counter incrementing
- ✅ Server connection: "Connected ✅"
- ✅ Real-time logs in the console

---

## 🆚 Architecture Comparison

| Feature | Old (WebSocket Protocol) | New (getUserMedia) |
|---------|--------------------------|-------------------|
| Audio Source | Recall.ai pushes events | Webpage pulls from meeting |
| Reliability | ❌ Kept disconnecting | ✅ Direct browser API |
| Setup Complexity | High (recording_config) | Low (just webpage URL) |
| Debugging | Hard (external service) | Easy (browser console) |
| Platform Support | Limited to Recall.ai's impl | Native browser support |

---

## 📖 Why This Approach?

From Recall.ai docs:
> "If you're building an AI agent that needs to listen to meeting audio, you can access a MediaStream object from a webpage running inside your bot"

This is the **officially recommended** approach for AI agents.

---

## 🎯 Benefits

1. ✅ **More Control**: Audio processing happens in your code
2. ✅ **Better Debugging**: Browser dev tools show everything
3. ✅ **Simpler Config**: No complex `realtime_endpoints` setup
4. ✅ **Direct Access**: No reliance on Recall.ai's WebSocket implementation
5. ✅ **Proven Pattern**: Documented approach for AI agents

---

## 🔧 Audio Format Details

- **Input**: Float32 from getUserMedia
- **Conversion**: 16-bit PCM (mono)
- **Sample Rate**: 16kHz (configurable via AudioContext)
- **Chunk Size**: 4096 samples (~256ms at 16kHz)
- **Encoding**: Base64 for WebSocket transport

---

## 🚨 Important Notes

1. **Bot must join meeting first** before audio capture starts
2. **Meeting permissions**: Ensure bot has audio access
3. **Browser compatibility**: Modern browsers support getUserMedia
4. **HTTPS required**: getUserMedia requires secure context

---

## 🐛 Troubleshooting

### No audio chunks received
- Check browser console in bot's webpage
- Verify getUserMedia permissions
- Ensure participants are speaking

### WebSocket disconnects
- Check ngrok is running
- Verify PUBLIC_URL in .env
- Ensure HTTPS (ngrok provides this)

### ElevenLabs not responding
- Verify ELEVENLABS_API_KEY
- Check AGENT_ID is correct
- Review ElevenLabs console logs

---

## 📚 References

- [Recall.ai: Send AI Agents to Meetings](https://docs.recall.ai/docs/getting-started)
- [MDN: getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)

---

## ✅ Ready to Test!

Your application now uses the recommended approach for AI meeting agents. Test it and watch the logs - you should see audio flowing from the webpage to your server to ElevenLabs! 🚀


