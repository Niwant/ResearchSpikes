require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { createServer } = require('http');
const { spawn } = require('child_process');

const app = express();
const server = createServer(app);

app.use(express.json());
app.use(express.static('public'));

// Store active connections
const connections = new Map(); // Maps recall-audio-in connections to their ElevenLabs connections
const botConnections = new Map(); // Maps wsId to bot ID for Output Audio API

// Create WebSocket server for meeting audio input (from webpage getUserMedia)
const meetingAudioInServer = new WebSocket.Server({ 
  noServer: true  // Changed to handle upgrade manually
});

console.log('📡 WebSocket server for /meeting-audio-in is ready');

// Create WebSocket server for Recall.ai audio input (direct from Recall.ai bot)
const recallAudioInServer = new WebSocket.Server({
  noServer: true
});

console.log('📡 WebSocket server for /recall-audio-in is ready (Recall.ai audio stream)');

// Create WebSocket server for agent audio output
const agentAudioOutServer = new WebSocket.Server({ 
  noServer: true  // Changed to handle upgrade manually
});

console.log('📡 WebSocket server for /agent-audio-out is ready');

// Handle WebSocket upgrade manually
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url;
  
  console.log(`\n🔄 [UPGRADE] WebSocket upgrade request for: ${pathname}`);
  console.log(`   Origin: ${request.headers.origin || 'none'}`);
  console.log(`   Host: ${request.headers.host}`);
  
  if (pathname === '/meeting-audio-in') {
    meetingAudioInServer.handleUpgrade(request, socket, head, (ws) => {
      meetingAudioInServer.emit('connection', ws, request);
    });
  } else if (pathname === '/recall-audio-in') {
    recallAudioInServer.handleUpgrade(request, socket, head, (ws) => {
      recallAudioInServer.emit('connection', ws, request);
    });
  } else if (pathname === '/agent-audio-out') {
    agentAudioOutServer.handleUpgrade(request, socket, head, (ws) => {
      agentAudioOutServer.emit('connection', ws, request);
    });
  } else {
    console.log(`   ❌ Unknown WebSocket path: ${pathname}`);
    socket.destroy();
  }
});

meetingAudioInServer.on('connection', (ws, request) => {
  console.log('\n🔵 [WEBPAGE] Connection established from webpage');
  console.log(`   From: ${request.headers.origin || request.headers.host || 'unknown'}`);
  console.log(`   User-Agent: ${request.headers['user-agent'] || 'unknown'}`);
  console.log(`   Ready state: ${ws.readyState}`);
  
  const wsId = Symbol('ws-id');
  connections.set(wsId, null);
  console.log(`   Active webpage connections: ${connections.size}`);
  
  let audioChunkCount = 0;
  let elevenlabsConnectionAttempts = 0;
  let lastConnectionAttempt = 0;
  let quotaExceeded = false; // Track if quota error occurred
  const MIN_RECONNECT_DELAY = 5000;
  const connectionTime = Date.now();
  
  // DON'T create ElevenLabs connection immediately
  // Wait until we actually receive audio chunks
  console.log('   💡 Will connect to ElevenLabs when audio starts...');

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'audio_chunk' && message.data) {
        audioChunkCount++;
        
        // Validate audio chunk
        if (!message.data || typeof message.data !== 'string') {
          console.error(`   ❌ Invalid audio chunk at ${audioChunkCount}: data is not a string`);
          return;
        }
        
        // Check if it's valid base64
        if (!/^[A-Za-z0-9+/=]+$/.test(message.data)) {
          console.error(`   ❌ Invalid audio chunk at ${audioChunkCount}: not valid base64`);
          return;
        }
        
        if (audioChunkCount % 20 === 0) {
          const audioSizeBytes = (message.data.length * 3) / 4;
          console.log(`🔊 [WEBPAGE] Received ${audioChunkCount} audio chunks (~${(audioSizeBytes / 1024).toFixed(2)} KB each)`);
          console.log(`   Sample rate: ${message.sampleRate || 'unknown'}, Format: ${message.format || 'unknown'}`);
        }
        
        // Get the PERSISTENT ElevenLabs connection
        let elevenlabsWs = connections.get(wsId);
        
        // Create connection on FIRST audio chunk only
        if (!elevenlabsWs || elevenlabsWs.readyState !== WebSocket.OPEN) {
          
          // If quota exceeded, STOP trying to reconnect
          if (quotaExceeded) {
            if (audioChunkCount % 50 === 0) {
              console.log(`   🚫 Not reconnecting - quota exceeded. Refresh page to retry.`);
            }
            return;
          }
          
          // If this is a reconnection attempt (not first), enforce delay
          if (elevenlabsConnectionAttempts > 0) {
            const now = Date.now();
            const timeSinceLastAttempt = now - lastConnectionAttempt;
            
            if (timeSinceLastAttempt < MIN_RECONNECT_DELAY) {
              if (audioChunkCount % 20 === 0) {
                console.log(`   ⏳ Waiting ${((MIN_RECONNECT_DELAY - timeSinceLastAttempt) / 1000).toFixed(1)}s before reconnecting...`);
              }
              return; // Skip this audio chunk
            }
          }
          
          elevenlabsConnectionAttempts++;
          lastConnectionAttempt = Date.now();
          
          if (elevenlabsConnectionAttempts === 1) {
            console.log(`\n   🎙️  Voice detected - connecting to ElevenLabs...`);
          } else {
            console.log(`\n   🔄 Reconnecting to ElevenLabs (attempt #${elevenlabsConnectionAttempts})`);
            console.log(`   ⚠️  Each reconnection starts a NEW conversation`);
          }
          
          try {
            elevenlabsWs = await createElevenLabsConnection(wsId);
            connections.set(wsId, elevenlabsWs);
            
            // Set up handler for quota errors
            elevenlabsWs.on('close', (code, reason) => {
              if (code === 1002 && reason && reason.toString().includes('quota')) {
                quotaExceeded = true;
                console.log('\n🚨 ========================================');
                console.log('   QUOTA LIMIT REACHED');
                console.log('   No more reconnections will be attempted');
                console.log('   Check: https://elevenlabs.io/app/usage');
                console.log('========================================\n');
              }
            });
            
            if (elevenlabsConnectionAttempts === 1) {
              console.log('   ✅ Connected! Conversation started.');
            } else {
              console.log('   ✅ Reconnected - new conversation started');
            }
          } catch (error) {
            console.error(`   ❌ Failed to connect: ${error.message}`);
            return;
          }
        }

        // Send audio through the SAME persistent connection
        if (elevenlabsWs && elevenlabsWs.readyState === WebSocket.OPEN) {
          try {
            const audioMessage = {
              user_audio_chunk: message.data
            };
            elevenlabsWs.send(JSON.stringify(audioMessage));
            
            // Log first chunk sent
            if (audioChunkCount === 1) {
              console.log(`   ✅ First audio chunk sent to ElevenLabs successfully`);
            }
          } catch (err) {
            console.error(`   ❌ Error sending to ElevenLabs: ${err.message}`);
          }
        } else {
          const state = elevenlabsWs ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][elevenlabsWs.readyState] : 'NULL';
          console.error(`   ❌ ElevenLabs connection not ready (state: ${state})`);
        }
      }
    } catch (error) {
      console.error('❌ [WEBPAGE] Error processing message:', error);
    }
  });

  ws.on('close', (code, reason) => {
    const elapsed = Date.now() - connectionTime;
    console.log(`\n🔴 [WEBPAGE] Disconnected after ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`   Close code: ${code}`);
    console.log(`   Audio chunks received: ${audioChunkCount}`);
    
    const elevenlabsWs = connections.get(wsId);
    if (elevenlabsWs) {
      console.log('   Closing associated ElevenLabs connection');
      elevenlabsWs.close();
    }
    connections.delete(wsId);
    console.log(`   Active webpage connections: ${connections.size}`);
  });

  ws.on('error', (error) => {
    console.error('❌ [WEBPAGE] WebSocket error:', error.message);
  });
});

// Handle Recall.ai audio stream
recallAudioInServer.on('connection', (ws, request) => {
  console.log('\n🟣 [RECALL.AI] Audio stream connected from Recall.ai bot');
  console.log(`   From: ${request.headers.origin || request.headers.host || 'unknown'}`);
  console.log(`   User-Agent: ${request.headers['user-agent'] || 'unknown'}`);
  
  const wsId = Symbol('recall-ws-id');
  connections.set(wsId, null);
  
  let audioChunkCount = 0;
  let elevenlabsConnectionAttempts = 0;
  let quotaExceeded = false;
  let isConnecting = false; // Track if connection is in progress
  const connectionTime = Date.now();
  
  console.log('   💡 Waiting for audio data from Recall.ai...');
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Recall.ai sends: { event: 'audio_mixed_raw.data', data: { data: { buffer: base64, ... }, ... } }
      // Per docs: https://docs.recall.ai/docs/real-time-audio-protocol
      
      if (message.event === 'audio_mixed_raw.data') {
        audioChunkCount++;
        
        // Extract base64-encoded audio buffer
        const audioData = message.data?.data?.buffer;
        
        if (!audioData) {
          console.log('   ⚠️  Message has no audio buffer');
          console.log('   Message:', JSON.stringify(message, null, 2).substring(0, 300));
          return;
        }
        
        if (audioChunkCount === 1) {
          console.log(`\n🟣 [RECALL.AI] First audio packet received!`);
          console.log(`   Format: 16kHz mono S16LE (16-bit PCM)`);
          console.log(`   Recording ID: ${message.data?.recording?.id || 'unknown'}`);
        }
        
        if (audioChunkCount % 20 === 0) {
          console.log(`🔊 [RECALL.AI] Received ${audioChunkCount} audio packets from Recall.ai`);
        }
        
        // Get or create ElevenLabs connection
        let elevenlabsWs = connections.get(wsId);
        
        if (!elevenlabsWs || elevenlabsWs.readyState !== WebSocket.OPEN) {
          if (quotaExceeded) {
            if (audioChunkCount % 50 === 0) {
              console.log(`   🚫 Not reconnecting - quota exceeded`);
            }
            return;
          }
          
          // Skip if already connecting (prevent multiple simultaneous attempts)
          if (isConnecting) {
            return; // Wait for current connection attempt to finish
          }
          
          isConnecting = true;
          elevenlabsConnectionAttempts++;
          
          if (elevenlabsConnectionAttempts === 1) {
            console.log(`\n   🎙️  Audio from Recall.ai - connecting to ElevenLabs...`);
          } else {
            console.log(`\n   🔄 Reconnecting to ElevenLabs (attempt #${elevenlabsConnectionAttempts})...`);
          }
          
          try {
            elevenlabsWs = await createElevenLabsConnection(wsId);
            connections.set(wsId, elevenlabsWs);
            
            elevenlabsWs.on('close', (code, reason) => {
              isConnecting = false; // Reset flag when connection closes
              if (code === 1002 && reason && reason.toString().includes('quota')) {
                quotaExceeded = true;
                console.log('\n🚨 QUOTA LIMIT REACHED\n');
              }
            });
            
            console.log('   ✅ Connected to ElevenLabs!');
            isConnecting = false; // Reset flag after successful connection
          } catch (error) {
            console.error(`   ❌ Failed to connect: ${error.message}`);
            isConnecting = false; // Reset flag on error
            return;
          }
        }
        
        // Send audio to ElevenLabs
        if (elevenlabsWs && elevenlabsWs.readyState === WebSocket.OPEN) {
          try {
            elevenlabsWs.send(JSON.stringify({
              user_audio_chunk: audioData
            }));
            
            if (audioChunkCount === 1) {
              console.log(`   ✅ First audio chunk sent to ElevenLabs from Recall.ai`);
            }
          } catch (err) {
            console.error(`   ❌ Error sending to ElevenLabs: ${err.message}`);
          }
        }
      }
      
    } catch (error) {
      console.error('❌ [RECALL.AI] Error processing message:', error);
      console.error('   Raw message:', data.toString().substring(0, 200));
    }
  });
  
  ws.on('close', (code, reason) => {
    const elapsed = Date.now() - connectionTime;
    console.log(`\n🔴 [RECALL.AI] Disconnected after ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`   Close code: ${code}`);
    console.log(`   Audio chunks received: ${audioChunkCount}`);
    
    const elevenlabsWs = connections.get(wsId);
    if (elevenlabsWs) {
      console.log('   Closing associated ElevenLabs connection');
      elevenlabsWs.close();
    }
    connections.delete(wsId);
  });
  
  ws.on('error', (error) => {
    console.error('❌ [RECALL.AI] WebSocket error:', error.message);
  });
});

// Store all connected agent-audio-out clients
const audioOutClients = new Set();

agentAudioOutServer.on('connection', (ws) => {
  console.log('\n🟢 [FRONTEND] Client connected to agent-audio-out');
  audioOutClients.add(ws);
  console.log(`   Total frontend clients: ${audioOutClients.size}`);

  ws.on('close', () => {
    console.log('\n🟡 [FRONTEND] Client disconnected from agent-audio-out');
    audioOutClients.delete(ws);
    console.log(`   Remaining frontend clients: ${audioOutClients.size}`);
  });

  ws.on('error', (error) => {
    console.error('❌ [FRONTEND] WebSocket error:', error);
  });
});

// Function to create ElevenLabs WebSocket connection
async function createElevenLabsConnection(wsId) {
  return new Promise((resolve, reject) => {
    // Try passing agent_id as query parameter instead of in message
    const elevenlabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}`;
    const ws = new WebSocket(elevenlabsUrl, [], {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY
      }
    });

    let connected = false;

    ws.on('open', () => {
      console.log('\n🟣 [ELEVENLABS] Connected to ElevenLabs API');
      console.log(`   Agent ID passed in URL: ${process.env.AGENT_ID}`);
      connected = true;
      
      // Wait for conversation_initiation_metadata message from ElevenLabs
      console.log('   ⏳ Waiting for conversation initialization...');
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Handle ping events (respond with pong to keep connection alive)
        if (message.type === 'ping') {
          // Per ElevenLabs docs: delay pong response by ping_ms if provided
          const delay = message.ping_event.ping_ms || 0;
          setTimeout(() => {
            const pongMessage = {
              type: 'pong',
              event_id: message.ping_event.event_id
            };
            ws.send(JSON.stringify(pongMessage));
          }, delay);
          return; // Don't log pings
        }
        
        // Log non-ping, non-audio messages
        if (message.type !== 'audio') {
          console.log(`\n🟣 [ELEVENLABS] Message type: ${message.type}`);
          console.log(`   Full message:`, JSON.stringify(message, null, 2));
        } else {
          console.log(`\n🟣 [ELEVENLABS] Message type: ${message.type}`);
        }

        // Handle error messages
        if (message.type === 'error') {
          console.error(`   ❌ ElevenLabs error: ${message.message || JSON.stringify(message)}`);
          ws.close();
          return;
        }

        // Handle audio events from ElevenLabs
        if (message.type === 'audio' && message.audio_event) {
          const audioData = message.audio_event.audio_base_64;
          if (audioData) {
            const audioSizeBytes = (audioData.length * 3) / 4;
            console.log(`   🎵 Audio response received (~${(audioSizeBytes / 1024).toFixed(2)} KB)`);
            
            // Validate audio data
            if (audioData.length < 100) {
              console.warn(`   ⚠️  WARNING: Audio data is very small (${audioData.length} chars) - might be empty`);
            }
            
            // Log first few bytes for format debugging
            try {
              const firstBytes = Buffer.from(audioData, 'base64').slice(0, 4);
              const bytesHex = Array.from(firstBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
              console.log(`   🔍 Audio header bytes: ${bytesHex}`);
            } catch (err) {
              console.error(`   ❌ Error decoding audio header: ${err.message}`);
            }
            
            // Broadcast to all connected audio-out clients
            let sentCount = 0;
            let errorCount = 0;
            audioOutClients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                try {
                  const audioMessage = JSON.stringify({
                    type: 'audio',
                    data: audioData,
                    timestamp: Date.now()
                  });
                  client.send(audioMessage);
                  sentCount++;
                } catch (err) {
                  console.error(`   ❌ Error sending to client: ${err.message}`);
                  errorCount++;
                }
              }
            });
            console.log(`   📤 Broadcasting: ${sentCount} sent, ${errorCount} failed, ${audioOutClients.size - sentCount - errorCount} not ready`);
            
            if (sentCount === 0) {
              console.warn(`   ⚠️  WARNING: No clients received audio! Check agent-audio-out connections.`);
            }
          } else {
            console.warn(`   ⚠️  WARNING: Received audio event but no audio_base_64 data`);
          }
        }

        // Handle conversation events
        if (message.type === 'conversation_initiation_metadata') {
          console.log('   ✅ Conversation initialized with ElevenLabs!');
          console.log('   Ready to receive audio and generate responses');
          if (!connected) {
            connected = true;
            resolve(ws);
          }
        }
        
        // Handle user transcript
        if (message.type === 'user_transcript') {
          console.log(`   👤 User said: "${message.user_transcription_event?.user_transcript || ''}"`);
        }
        
        // Handle agent response
        if (message.type === 'agent_response') {
          console.log(`   🤖 Agent responding...`);
        }
      } catch (error) {
        console.error('❌ [ELEVENLABS] Error processing message:', error);
        console.error('   Raw message:', data.toString().substring(0, 500));
      }
    });

    ws.on('error', (error) => {
      console.error('❌ [ELEVENLABS] WebSocket error:', error.message);
      console.error('   Error details:', error);
      if (!connected) {
        reject(error);
      }
    });

    ws.on('close', (code, reason) => {
      console.log('\n🔴 [ELEVENLABS] Disconnected from ElevenLabs');
      console.log(`   Close code: ${code}`);
      console.log(`   Close reason: ${reason || '(none provided)'}`);
      
      // Log common close codes
      if (code === 1000) {
        console.log(`   ✅ Normal closure`);
      } else if (code === 1008) {
        console.log(`   ⚠️  Policy violation - check API key or agent ID`);
      } else if (code === 1002) {
        console.log(`   ⚠️  Protocol error - message format might be wrong`);
      } else if (code === 4000) {
        console.log(`   ⚠️  Custom error - check ElevenLabs docs`);
      } else if (code === 4300) {
        console.log(`   ⚠️  CAPACITY ERROR - Agent at max concurrent connections`);
        console.log(`   💡 Will wait 5s before reconnecting`);
      } else if (code === 1002 && reason && reason.includes('quota')) {
        console.log(`   🚨 QUOTA LIMIT EXCEEDED!`);
        console.log(`   💡 Check your ElevenLabs account: https://elevenlabs.io/app/usage`);
        console.log(`   💡 You may need to upgrade your plan or wait for quota reset`);
      }
      
      const elevenlabsWs = connections.get(wsId);
      if (elevenlabsWs === ws) {
        connections.set(wsId, null);
        console.log('   Connection reset for this session');
      }
    });

    // Resolve after a short delay to ensure connection is established
    setTimeout(() => {
      if (connected) {
        resolve(ws);
      } else {
        reject(new Error('Failed to establish ElevenLabs connection'));
      }
    }, 2000);
  });
}

// POST endpoint to join meeting
app.post('/join-meeting', async (req, res) => {
  try {
    const { meeting_url } = req.body;

    if (!meeting_url) {
      return res.status(400).json({ error: 'meeting_url is required' });
    }

    console.log('\n📞 [JOIN-MEETING] Creating bot for meeting:', meeting_url);

    // Prepare the bot configuration according to Recall.ai documentation
    // https://docs.recall.ai/docs/real-time-audio-protocol
    const publicUrl = process.env.PUBLIC_URL.replace('https://', '').replace('http://', '');
    
    // Use agent-minimal.html (ULTRA minimal - just audio, no UI)
    // This reduces bandwidth and network jitter for clearer audio
    const webpageUrl = `${process.env.PUBLIC_URL}/agent-minimal.html`;
    
    // Recall.ai bot configuration with real-time audio WebSocket
    // Per docs: https://docs.recall.ai/docs/real-time-audio-protocol
    const botConfig = {
      meeting_url: meeting_url,
      bot_name: 'AI Agent Bot',
      
      // Audio INPUT: Recall.ai sends meeting audio to our WebSocket
      recording_config: {
        audio_mixed_raw: {},  // Enable raw audio streaming
        realtime_endpoints: [
          {
            type: 'websocket',
            url: `wss://${publicUrl}/recall-audio-in`,
            events: ['audio_mixed_raw.data']
          }
        ]
      },
      
      // Audio OUTPUT: Ultra-minimal webpage (black screen, audio only)
      // Reduces bandwidth significantly for clearer audio
      output_media: {
        camera: {
          kind: 'webpage',
          config: {
            url: webpageUrl
          }
        }
      },
      
      // Enable audio output capability
      automatic_audio_output: {
        in_call_recording: {
          data: {
            kind: 'mp3',
            // 1 second of silence as base64 (enables Output Audio API)
            b64_data: '//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADhAC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLz///////////////////////////////////////////8AAAA5TEFNRTMuMTAwBK8AAAAAAAAAABQgJAUHQQAB4AAAA4SWa8a1AAAAAAD/+xDEAAADmA+gAAAA9wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
          }
        }
      },
      
      // Automatic leave settings
      automatic_leave: {
        waiting_room_timeout: 600,
        noone_joined_timeout: 600
      }
    };
    
    console.log(`   Webpage URL: ${webpageUrl}`);
    console.log(`\n   ℹ️  Using ULTRA-MINIMAL webpage (audio only, no UI)`);
    console.log(`   This reduces bandwidth and jitter for CLEAR audio`);
    console.log(`   📥 Audio INPUT: Recall.ai WebSocket → /recall-audio-in → ElevenLabs`);
    console.log(`   📤 Audio OUTPUT: ElevenLabs → /agent-audio-out → agent-minimal.html → Meeting`);
    console.log(`\n   🔍 Bot config being sent:`);
    console.log(JSON.stringify(botConfig, null, 2));
    console.log();

    // Create bot via Recall.ai API
    const response = await fetch('https://us-west-2.recall.ai/api/v1/bot/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${process.env.RECALL_API_KEY}`
      },
      body: JSON.stringify(botConfig)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Recall.ai API error:', errorText);
      return res.status(response.status).json({ 
        error: 'Failed to create bot',
        details: errorText 
      });
    }

    const botData = await response.json();
    console.log('   ✅ Bot created successfully!');
    console.log(`   Bot ID: ${botData.id}`);
    console.log(`   Bot Status: ${botData.status || 'unknown'}`);
    console.log(`\n   🔍 View bot in Explorer Dashboard:`);
    console.log(`   https://us-west-2.recall.ai/dashboard/explorer/bot/${botData.id}`);
    console.log(`\n   Full bot data:`, JSON.stringify(botData, null, 2));
    
    // Poll bot status
    let statusCheckCount = 0;
    const checkBotStatus = setInterval(async () => {
      statusCheckCount++;
      try {
        const statusResponse = await fetch(`https://us-west-2.recall.ai/api/v1/bot/${botData.id}/`, {
          headers: {
            'Authorization': `Token ${process.env.RECALL_API_KEY}`
          }
        });
        const statusData = await statusResponse.json();
        
        // Check status changes array for more info (per Recall.ai debugging docs)
        const statusChanges = statusData.status_changes || [];
        const latestStatusChange = statusChanges.length > 0 ? statusChanges[statusChanges.length - 1] : null;
        
        console.log(`\n   📊 Bot Status Check #${statusCheckCount}: ${statusData.status || 'unknown'}`);
        
        // Log all status changes for debugging
        if (statusChanges.length > 0) {
          console.log(`   📋 Total status changes: ${statusChanges.length}`);
          const recentChanges = statusChanges.slice(-3);
          recentChanges.forEach((change, idx) => {
            console.log(`      ${idx + 1}. [${change.created_at}] ${change.code}${change.sub_code ? ' (sub: ' + change.sub_code + ')' : ''}`);
          });
        }
        
        if (latestStatusChange) {
          console.log(`   Latest: ${latestStatusChange.code}${latestStatusChange.sub_code ? ' - ' + latestStatusChange.sub_code : ''}`);
        }
        
        if (statusData.recordings && statusData.recordings.length > 0) {
          const latestRecording = statusData.recordings[statusData.recordings.length - 1];
          console.log(`   📹 Recording status: ${latestRecording.status || 'unknown'}`);
          console.log(`   📹 Recording ID: ${latestRecording.id}`);
        }
        
        if (statusData.status === 'in_meeting') {
          console.log('   ✅ Bot is now in the meeting!');
        }
        
        if (statusData.status === 'waiting_in_lobby') {
          console.log('   ⏳ Bot is waiting in lobby - admit it to the meeting!');
        }
        
        if (statusData.status === 'call_ended' || statusData.status === 'left') {
          console.log('   ❌ Bot call ended');
          clearInterval(checkBotStatus);
        }
        
        // Check if there are fatal errors in status changes
        const fatalErrors = statusChanges.filter(change => change.code === 'fatal');
        if (fatalErrors.length > 0) {
          console.log(`   ❌ FATAL ERROR detected: ${fatalErrors[0].sub_code || 'unknown'}`);
        }
      } catch (error) {
        console.error('   Error checking bot status:', error.message);
      }
    }, 5000);
    
    // Stop checking after 2 minutes
    setTimeout(() => clearInterval(checkBotStatus), 120000);

    res.json({ 
      success: true, 
      bot_id: botData.id,
      message: 'Bot joined the meeting successfully'
    });

  } catch (error) {
    console.error('Error joining meeting:', error);
    res.status(500).json({ 
      error: 'Failed to join meeting',
      details: error.message 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connections: connections.size,
    webpage_connections: meetingAudioInServer.clients.size,
    agent_connections: agentAudioOutServer.clients.size
  });
});

// Endpoint to check bot status
app.get('/bot/:botId', async (req, res) => {
  try {
    const { botId } = req.params;
    const response = await fetch(`https://us-west-2.recall.ai/api/v1/bot/${botId}/`, {
      headers: {
        'Authorization': `Token ${process.env.RECALL_API_KEY}`
      }
    });
    
    const botData = await response.json();
    res.json(botData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint
app.get('/test', (req, res) => {
  res.json({
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    ngrok_url: process.env.PUBLIC_URL,
    meeting_audio_websocket: `wss://${process.env.PUBLIC_URL.replace('https://', '').replace('http://', '')}/meeting-audio-in`,
    agent_audio_websocket: `wss://${process.env.PUBLIC_URL.replace('https://', '').replace('http://', '')}/agent-audio-out`,
    webpage_url: `${process.env.PUBLIC_URL}/agent.html`,
    active_webpage_connections: meetingAudioInServer.clients.size,
    active_agent_connections: agentAudioOutServer.clients.size
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('\n🚀 ========================================');
  console.log(`   Server running on port ${PORT}`);
  console.log(`   WebSocket servers ready at:`);
  console.log(`   🟣 ws://localhost:${PORT}/recall-audio-in (from Recall.ai bot)`);
  console.log(`   🔵 ws://localhost:${PORT}/meeting-audio-in (from webpage - fallback)`);
  console.log(`   🟢 ws://localhost:${PORT}/agent-audio-out (to agent.html)`);
  console.log('========================================\n');
  console.log('🎯 Primary audio source: Recall.ai real-time audio protocol');
  console.log('   Recall.ai captures meeting audio and sends to /recall-audio-in');
  console.log('   agent.html receives AI responses via /agent-audio-out\n');
  console.log('⚠️  Make sure to expose this server with ngrok');
  console.log('   and update PUBLIC_URL in .env with your ngrok URL\n');
  
  // Add connection monitoring
  setInterval(() => {
    if (recallAudioInServer.clients.size === 0 && meetingAudioInServer.clients.size === 0) {
      console.log('⏳ Still waiting for audio input connection (Recall.ai or webpage)...');
    }
    if (agentAudioOutServer.clients.size === 0) {
      console.log('⏳ Still waiting for audio output connection (agent.html)...');
    }
  }, 30000); // Log every 30 seconds if no connections
});

