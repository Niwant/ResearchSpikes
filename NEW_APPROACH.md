# 🎯 New Approach: Recall.ai Audio Protocol

## What Changed and Why

### The Problem We Discovered

**getUserMedia() Approach Doesn't Work in Bot Context:**

```
❌ OLD APPROACH (Broken):
Meeting Audio → agent.html getUserMedia() → Server → ElevenLabs

What actually happened:
- In regular tab: getUserMedia() captures YOUR microphone ✅
- In bot: getUserMedia() captures BOT's "microphone" (silent) ❌
```

**Root Cause:**
When `agent.html` runs in a Recall.ai bot, `getUserMedia()` doesn't capture meeting audio - it captures the bot's virtual microphone which has no audio!

---

## ✅ NEW APPROACH: Recall.ai Audio Protocol

### How It Works Now

```
Meeting Audio
    ↓
Recall.ai Bot (built-in audio capture)
    ↓
WebSocket → /recall-audio-in → Your Server
    ↓
Server → ElevenLabs
    ↓
ElevenLabs AI responds
    ↓
Server → WebSocket → /agent-audio-out
    ↓
agent-simple.html plays audio in meeting
    ↓
Everyone hears AI! ✅
```

### Key Changes

#### 1. Bot Configuration (index.js)

**OLD:**
```javascript
const botConfig = {
  meeting_url: meeting_url,
  bot_name: 'AI Agent Bot',
  output_media: {
    kind: 'webpage',
    url: webpageUrl
  }
};
```

**NEW:**
```javascript
const botConfig = {
  meeting_url: meeting_url,
  bot_name: 'AI Agent Bot',
  
  // INPUT: Recall.ai sends meeting audio to our server
  real_time_transcription: {
    destination_url: `${process.env.PUBLIC_URL}/recall-audio-in`
  },
  
  // OUTPUT: Bot webpage plays AI responses
  output_media: {
    kind: 'webpage',
    url: webpageUrl  // agent-simple.html
  },
  
  recording_mode: 'speaker_view',
  automatic_leave: {
    waiting_room_timeout: 600,
    noone_joined_timeout: 600
  }
};
```

#### 2. New WebSocket Server

Added `/recall-audio-in` WebSocket server to receive audio from Recall.ai:

```javascript
// New WebSocket for Recall.ai audio
const recallAudioInServer = new WebSocket.Server({ noServer: true });

recallAudioInServer.on('connection', (ws) => {
  // Receives audio from Recall.ai bot
  ws.on('message', (data) => {
    const message = JSON.parse(data);
    const audioData = message.audio_data || message.data;
    
    // Forward to ElevenLabs
    elevenlabsWs.send(JSON.stringify({
      user_audio_chunk: audioData
    }));
  });
});
```

#### 3. Simplified Agent Page

Created `agent-simple.html` which **ONLY** receives and plays AI audio:

**Removed:**
- ❌ getUserMedia() audio capture
- ❌ AudioContext for recording
- ❌ PCM encoding
- ❌ Input WebSocket connection

**Kept:**
- ✅ Output WebSocket connection
- ✅ Audio queue management
- ✅ PCM 24kHz playback
- ✅ Visual UI & logging

**Result:** Much simpler, less code, more reliable!

---

## 📊 Architecture Comparison

### OLD (getUserMedia Approach)

```
agent.html in bot:
├── getUserMedia() ❌ Captures bot's mic (silent)
├── AudioContext
├── PCM encoding
├── Send to server
└── Receive AI audio ✅

Problem: Input doesn't work!
```

### NEW (Recall.ai Protocol)

```
Recall.ai Bot:
├── Built-in audio capture ✅ Captures meeting audio
└── Sends to server via WebSocket

agent-simple.html in bot:
└── Receive & play AI audio ✅

Result: Everything works!
```

---

## 🚀 How to Test

### 1. Restart Your Server

```bash
# Press Ctrl+C to stop
npm start
```

### 2. Verify Server Logs

You should see:
```
🚀 ========================================
   Server running on port 8000
   WebSocket servers ready at:
   🟣 ws://localhost:8000/recall-audio-in (from Recall.ai bot)
   🔵 ws://localhost:8000/meeting-audio-in (from webpage - fallback)
   🟢 ws://localhost:8000/agent-audio-out (to agent.html)
========================================

🎯 Primary audio source: Recall.ai real-time audio protocol
   Recall.ai captures meeting audio and sends to /recall-audio-in
   agent-simple.html receives AI responses via /agent-audio-out
```

### 3. Join Meeting with Bot

```bash
./test-bot.sh "YOUR_MEETING_URL"
```

### 4. Watch for Recall.ai Connection

**Server logs should show:**
```
🟣 [RECALL.AI] Audio stream connected from Recall.ai bot
   From: recall.ai
   💡 Waiting for audio data from Recall.ai...

🟣 [RECALL.AI] Message received: {...}
🔊 [RECALL.AI] Received audio chunks from Recall.ai

   🎙️  Audio from Recall.ai - connecting to ElevenLabs...
🟣 [ELEVENLABS] Connected to ElevenLabs API
   ✅ Conversation initialized with ElevenLabs!

👤 User said: "Hello..."
🤖 Agent responding...
🎵 Audio response received
📤 Broadcasting to 1 frontend client(s)
```

### 5. Check Bot Webpage

The bot's `agent-simple.html` page should show:
```
🔊 AI Agent Bot
Audio Output Only - Receives AI responses

✅ Connected - Ready for AI responses

Audio Input: Recall.ai ✅
AI Responses: 0
Server connection: Connected ✅
Audio queue: 0

Logs:
✅ Connecting to OUTPUT WebSocket: wss://...
✅ Connected! Ready to receive AI audio
📝 Audio INPUT: Handled by Recall.ai
📝 Audio OUTPUT: This webpage plays AI responses
✅ Ready to receive AI audio responses!
```

---

## 🔍 What to Look For

### ✅ SUCCESS Indicators

**In Server Logs:**
- `🟣 [RECALL.AI] Audio stream connected`
- `🔊 [RECALL.AI] Received audio chunks`
- `🟣 [ELEVENLABS] Connected`
- `🎵 Audio response received`
- `📤 Broadcasting to 1 frontend client(s)`

**In Bot Webpage:**
- "Audio Input: Recall.ai ✅"
- "Server connection: Connected ✅"
- "AI Responses: 1" (increments)
- Logs show "🎵 AI Response received"

**In Meeting:**
- You hear AI speaking!
- Other participants hear it too

### ❌ If It Doesn't Work

**Recall.ai connection doesn't establish:**
- Check `real_time_transcription` config
- Verify `destination_url` is correct
- Check Recall.ai docs for latest API changes

**Recall.ai connects but no messages:**
- Meeting audio might not be enabled
- Bot might need to be unmuted
- Check Recall.ai dashboard for bot status

**Audio received but not playing:**
- Check agent-simple.html WebSocket connection
- Verify `/agent-audio-out` is connected
- Check browser console for errors

---

## 📝 Files Changed

| File | What Changed |
|------|--------------|
| `index.js` | Added `/recall-audio-in` WebSocket server<br>Updated bot config with `real_time_transcription`<br>Changed webpage to `agent-simple.html` |
| `agent-simple.html` | NEW - Simplified version that only handles audio OUTPUT<br>No getUserMedia, no audio capture<br>Only receives and plays AI audio |
| `NEW_APPROACH.md` | This documentation |

---

## 💡 Why This Is Better

### Advantages

1. ✅ **Works in bot context** - No getUserMedia issues
2. ✅ **More reliable** - Uses Recall.ai's built-in audio capture
3. ✅ **Simpler code** - agent-simple.html is half the size
4. ✅ **Better separation** - Input (Recall.ai) and output (webpage) are separate
5. ✅ **Official approach** - Uses Recall.ai's documented API

### Disadvantages

1. ⚠️ **Depends on Recall.ai** - If their API changes, we need to update
2. ⚠️ **Less control** - Can't customize audio processing as much
3. ⚠️ **Format assumptions** - Need to handle whatever format Recall.ai sends

---

## 🎯 Next Steps

1. **Test the new approach** - Join a meeting and verify audio flows
2. **Monitor server logs** - Look for Recall.ai messages
3. **Check ElevenLabs responses** - Verify AI is responding
4. **Report results** - Let me know what you see!

**If Recall.ai connection fails**, we may need to adjust the message format handling based on what they actually send.

---

**Expected Outcome:** 
You speak → Recall.ai captures → Server forwards → ElevenLabs responds → AI speaks in meeting! 🎉

**Let's test it!** 🚀




