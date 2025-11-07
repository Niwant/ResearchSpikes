# 🔧 Troubleshooting: Bot Joins but No Audio

## Problem Description
- ✅ Bot joins meeting successfully
- ✅ agent.html page loads
- ✅ WebSockets connect
- ❌ No audio chunks sent to ElevenLabs
- ❌ No AI responses in meeting
- ✅ BUT works when opening agent.html in regular browser tab

## Root Cause
When `agent.html` opens in a **regular browser tab**, `getUserMedia()` captures **YOUR microphone**. But when it runs in a **Recall.ai bot**, it needs to capture **MEETING audio** instead.

---

## 🔍 Step 1: Run Diagnostics

### A. In the Meeting
1. Look at the bot's `agent.html` page in the meeting
2. Check the logs at the bottom
3. Look for these key indicators:

**✅ GOOD SIGNS:**
```
🎤 Audio levels - Volume: 15.234, Silent: 5, Active: 95
Sent 10 audio chunks to server (vol: 15.23)
```

**❌ BAD SIGNS:**
```
⚠️ Audio levels - Volume: 0.001, Silent: 200, Active: 0
⚠️ WARNING: Only SILENCE detected!
💡 TIP: The bot should capture meeting audio automatically
```

### B. Open Diagnostic Page in the Bot

Instead of using `agent.html`, try the diagnostic page:

**Option 1: Update bot to use diagnose.html temporarily**

```bash
# Edit .env and temporarily change the webpage
# (We'll create a script for this)
```

**Option 2: Open diagnose.html in a regular tab first**

```bash
# In your browser (not in meeting)
open http://localhost:8000/diagnose.html
```

This will tell you:
- ✅ If getUserMedia works
- ✅ What audio source is being captured
- ✅ If audio levels are detected

---

## 🎯 Step 2: What the Logs Tell You

### Scenario A: Silent Audio

**Logs show:**
```
✅ Audio access granted
Audio tracks: 1
Track 0: Default, enabled: true, muted: false
🎤 Audio levels - Volume: 0.001 ← PROBLEM!
⚠️ WARNING: Only SILENCE detected!
```

**This means:**
- getUserMedia() IS working
- Audio IS being captured
- BUT it's capturing SILENCE (wrong source)

**Solution:** The bot is capturing its own "microphone" (which has no audio) instead of the meeting audio. This is a Recall.ai bot configuration issue.

### Scenario B: No Audio Tracks

**Logs show:**
```
❌ getUserMedia not supported
OR
❌ Permission denied
```

**This means:**
- Browser doesn't have permission
- Wrong browser/context

**Solution:** Check bot browser permissions

### Scenario C: Audio IS Being Captured!

**Logs show:**
```
✅ Audio access granted
🎤 Audio levels - Volume: 15.234, Silent: 5, Active: 95
```

**But still no ElevenLabs response?**

**Check:**
1. Server logs - are chunks reaching the server?
2. ElevenLabs connection - is it connected?
3. API quota - have you exceeded limits?

---

## 🛠️ Solutions

### Solution 1: Verify Bot Configuration

When creating the bot, ensure it's configured for audio capture:

```javascript
// In index.js, check the bot config
const botConfig = {
  meeting_url: meeting_url,
  bot_name: 'AI Agent Bot',
  output_media: {
    kind: 'webpage',
    url: webpageUrl
  }
  // Add this if missing:
  // automatic_audio_output: {
  //   in_meeting: true  // Enables bot to play audio
  // }
};
```

### Solution 2: Check Your Server Port

Your server is running on **port 8000**, not 3000:

```bash
# Make sure ngrok is forwarding the correct port
ngrok http 8000  # NOT 3000!

# Verify in .env
PORT=8000
PUBLIC_URL=https://meetbot.ngrok.dev
```

### Solution 3: Test with Diagnostic Page

Update bot to load the diagnostic page instead:

```bash
# Temporarily change this in index.js line ~379
const webpageUrl = `${process.env.PUBLIC_URL}/diagnose.html`;  // Changed from /agent.html
```

Then rejoin the meeting and check what the diagnostic page shows.

### Solution 4: Ensure Meeting Audio Permission

In some meeting platforms, the bot needs explicit permission:

**For Zoom:**
1. Admit bot from waiting room
2. Ensure bot is NOT muted
3. Check bot has "Share audio" enabled

**For Google Meet:**
1. Grant bot microphone permission
2. Ensure bot shows as "Speaking" when you speak

### Solution 5: Check Audio Source Selection

The bot might be using the wrong audio source. In the diagnostic page, check:

```
Track 0: Label = "Default" ← Might be wrong!
Should be: "Meeting Audio" or similar
```

If the label is generic like "Default" or "Built-in Microphone", it's not capturing meeting audio.

---

## 🔬 Deep Debugging

### Check Browser Console in Bot

1. In the meeting, find the bot's webpage
2. Right-click → Inspect Element
3. Go to Console tab
4. Look for errors:

```javascript
// Good:
✅ AudioContext created (sampleRate: 16000Hz)
✅ Audio processing pipeline established

// Bad:
❌ DOMException: Permission denied
❌ NotAllowedError: Permission dismissed
❌ TypeError: Cannot read property 'getChannelData'
```

### Check Server Logs

Your server should show:

```bash
🔵 [WEBPAGE] Connection established from webpage
   Active webpage connections: 1

# If you see this, WebSocket is working

🔊 [WEBPAGE] Received 20 audio chunks
   Sample rate: 16000, Format: pcm16

# If you DON'T see this, audio isn't being sent
```

### Check ElevenLabs Connection

```bash
# Good:
🟣 [ELEVENLABS] Connected to ElevenLabs API
✅ Conversation initialized with ElevenLabs!

# Bad:
❌ [ELEVENLABS] Close code: 1008
⚠️ Policy violation - check API key
```

---

## 📊 Quick Diagnostic Checklist

Run through this checklist:

- [ ] Server running on correct port (8000)
- [ ] ngrok forwarding port 8000 (not 3000)
- [ ] PUBLIC_URL in .env matches ngrok URL
- [ ] Bot joins meeting successfully
- [ ] agent.html loads in meeting
- [ ] Both WebSockets show "Connected ✅"
- [ ] Audio chunks counter increases when you speak
- [ ] Audio volume shows > 0.1 (not just silence)
- [ ] Server logs show "Received audio chunks"
- [ ] ElevenLabs connection established
- [ ] API quota not exceeded

**If all checks pass but still no audio:**
→ The issue is likely with audio capture source selection in the bot context

---

## 🎯 Most Likely Issues

Based on your symptoms (works in tab, not in bot):

### 1. **Wrong Audio Source** (Most Likely)
- Bot is capturing its own mic (silence)
- Not capturing meeting audio
- Solution: Check Recall.ai bot audio configuration

### 2. **Permissions Issue**
- Bot browser doesn't have mic permission
- Solution: Grant permissions in meeting

### 3. **Port Mismatch**
- Server on 8000, but bot trying to connect to 3000
- Solution: Verify PUBLIC_URL and restart bot

---

## 🚑 Emergency Workaround

If you can't get the bot audio working, you can use the **hybrid approach**:

1. **Bot joins meeting** (for video presence)
2. **You run agent.html in your browser** (for audio I/O)
3. **Your browser** sends/receives audio via WebSockets
4. **You** are the "audio bridge" between meeting and AI

This works because:
- Your browser can capture meeting audio (if you're in the meeting)
- Your browser can play AI responses (which get transmitted to meeting)

**Not ideal, but proves the pipeline works!**

---

## 📞 Next Steps

1. **Open diagnose.html in bot** to see exact audio capture status
2. **Check browser console** for permission errors
3. **Verify audio volume** is above 0.1 when people speak
4. **Report findings** - tell me what you see!

Based on what you find, we can adjust the bot configuration or audio capture method.

---

## 💡 Pro Tips

- **Test with Google Meet** - Often more reliable than Zoom for bots
- **Speak loudly** - Low volume might be filtered out
- **Check bot isn't muted** - In meeting settings
- **Try different browsers** - Recall.ai bots use Chromium

---

**Need help?** Share:
1. What browser console shows
2. What agent.html logs show
3. What server logs show
4. Screenshot of bot's webpage

I can help identify the exact issue!




