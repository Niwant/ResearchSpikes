# 🚨 Quick Debugging Steps

## Your Issue
✅ Bot joins meeting  
❌ No audio going to ElevenLabs  
✅ Works in regular browser tab  

## The Fix (Step by Step)

### 1️⃣ Restart Your Server

Press `Ctrl+C` to stop the server, then:

```bash
cd /Users/niwantsalunke/Downloads/UNCC/Projects/ResearchSpikes
npm start
```

**Important:** Make sure ngrok is still running on port **8000** (not 3000):

```bash
# In another terminal, verify ngrok is running:
lsof -i :8000
```

### 2️⃣ Send New Bot with Diagnostic Page

```bash
./test-bot.sh "YOUR_MEETING_URL"
```

### 3️⃣ Check the Diagnostic Page in Meeting

When the bot joins, it will now show the **Diagnostic Page** instead of agent.html.

**What to do:**
1. Click **"Test getUserMedia"** button
2. Click **"Start Monitoring"** button
3. **Speak into your microphone**
4. Watch the **volume meter**

### 4️⃣ Tell Me What You See

**Scenario A: Volume Bar Moves (Good!)**
```
Volume: 15.23%
Silent samples: 5
Active samples: 95
```
→ **Audio IS being captured!** Problem is elsewhere.

**Scenario B: Volume Bar is Empty (Bad!)**
```
Volume: 0.00%
Silent samples: 200
Active samples: 0
⚠️ WARNING: Only silence detected!
```
→ **Audio source problem!** Bot capturing wrong source.

**Scenario C: Error**
```
❌ FAILED: NotAllowedError
Permission denied
```
→ **Permission problem!** Bot doesn't have mic access.

---

## Based on What You See

### If Volume Moves ✅
The bot CAN capture audio! Check:
- [ ] Server logs - are chunks reaching server?
- [ ] ElevenLabs connection - is it established?
- [ ] API quota - check https://elevenlabs.io/app/usage

### If Only Silence ⚠️
The bot is capturing the WRONG audio source. This is the most likely issue.

**Why it happens:**
- In a regular browser tab: getUserMedia() captures YOUR mic ✅
- In Recall.ai bot: getUserMedia() might capture bot's "virtual mic" (silent) ❌

**Solutions:**

**Option 1: Check Recall.ai Bot Audio Settings**

The bot might need to be configured differently. Check Recall.ai docs:
https://docs.recall.ai/docs/getting-started

Look for:
- Audio input settings
- Microphone selection
- Meeting audio capture

**Option 2: Use Recall.ai's Audio API Directly**

Instead of getUserMedia(), use Recall.ai's built-in audio capture:
- Real-time audio protocol
- Direct meeting audio stream
- More reliable for bots

**Option 3: Hybrid Approach (Temporary)**

While we debug:
1. Keep bot in meeting (for video presence)
2. Open agent.html in YOUR browser
3. Join meeting yourself
4. Your browser bridges audio ↔ ElevenLabs

---

## Switch Back to Agent Page

Once diagnosed, switch back:

```javascript
// In index.js line 422-423:
const webpageUrl = `${process.env.PUBLIC_URL}/agent.html`;       // Production
// const webpageUrl = `${process.env.PUBLIC_URL}/diagnose.html`;   // Diagnostic mode
```

---

## Tell Me

After running the diagnostic:

1. **What does "Test getUserMedia" show?**
   - Success? Failed?
   - How many tracks?
   - Track labels?

2. **What does volume monitoring show?**
   - 0.00% (silence)?
   - > 1% (active)?

3. **What does browser console show?**
   - Any errors?
   - Warnings?

Based on this, I can tell you exactly what needs to be fixed!




