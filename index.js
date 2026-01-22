require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { createServer } = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = createServer(app);

// Apply JSON parser to all routes except webhook (we need raw body for signature verification)
app.use((req, res, next) => {
  if (req.path === '/webhook/elevenlabs') {
    return next(); // Skip JSON parsing for webhook route
  }
  express.json()(req, res, next);
});
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
          console.log(`   ⏳ Waiting for more audio packets before connecting to ElevenLabs...`);
        }
        
        if (audioChunkCount % 20 === 0) {
          console.log(`🔊 [RECALL.AI] Received ${audioChunkCount} audio packets from Recall.ai`);
        }
        
        // Wait for at least 5 audio packets before connecting to ElevenLabs
        // This ensures the bot is actually in the meeting and capturing real audio,
        // not just test packets sent before the bot fully joins
        const MIN_AUDIO_PACKETS_BEFORE_CONNECT = 5;
        
        if (audioChunkCount < MIN_AUDIO_PACKETS_BEFORE_CONNECT) {
          if (audioChunkCount === MIN_AUDIO_PACKETS_BEFORE_CONNECT - 1) {
            console.log(`   ✅ Received ${audioChunkCount} packets - bot appears to be in meeting`);
          }
          // Don't connect yet, just buffer the audio packets
          return;
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
            console.log(`\n   🎙️  Bot confirmed in meeting (${audioChunkCount} packets) - connecting to ElevenLabs...`);
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

// ============================================================================
// Agentic Document Generation Functions
// ============================================================================

/**
 * Fetch agent details from ElevenLabs API
 */
async function getAgentDetails(agentId) {
  try {
    console.log(`\n🤖 [AGENT] Fetching agent details for ID: ${agentId}`);
    
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      console.log('   ⚠️  ELEVENLABS_API_KEY not found, skipping agent details');
      return null;
    }
    
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      method: 'GET',
      headers: {
        'xi-api-key': apiKey
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`   ⚠️  Failed to fetch agent details: ${response.status} - ${errorText}`);
      return null;
    }
    
    const agentData = await response.json();
    console.log(`   ✅ Agent details fetched successfully`);
    console.log(`   Agent name: ${agentData.name || 'Unknown'}`);
    
    return {
      name: agentData.name,
      system_prompt: agentData.system_prompt || agentData.prompt || '',
      description: agentData.description || ''
    };
    
  } catch (error) {
    console.error(`❌ [AGENT] Error fetching agent details:`, error);
    return null;
  }
}

/**
 * Generate markdown document from transcript using OpenAI
 */
async function generateMarkdownDocument(cleanedTranscript, agentDetails = null) {
  try {
    console.log(`\n🤖 [LLM] Generating markdown document...`);
    
    // Format transcript for LLM
    const transcriptText = cleanedTranscript.map(item => {
      if (item.role === 'agent') {
        return `Agent: ${item.original_message || ''}`;
      } else if (item.role === 'user') {
        return `User: ${item.message || ''}`;
      }
      return JSON.stringify(item);
    }).join('\n');
    
    // Build context from agent details if available
    let contextSection = '';
    if (agentDetails && agentDetails.system_prompt) {
      contextSection = `
YOUR IDENTITY AND ROLE:
You are the agent described by this system prompt:
${agentDetails.system_prompt}

${agentDetails.description ? `Agent Description: ${agentDetails.description}` : ''}

You are NOT writing a meeting summary or transcript. You are writing a professional document from YOUR perspective as this agent, based on the conversation that occurred.
`;
    } else {
      contextSection = `
You are writing a professional document based on the conversation that occurred.
`;
    }
    
    // Create prompt for LLM to generate markdown directly with conditional logic
    const prompt = `You are a professional document writer. ${agentDetails ? 'You are the agent described in the system prompt above.' : ''} Based on the conversation transcript below, analyze the conversation type and write the appropriate document.

${contextSection}
CONVERSATION TRANSCRIPT:
${transcriptText}

ANALYZE THE CONVERSATION TYPE:

1. **Data Gathering Conversation**: If the conversation involved gathering information/data from an employee (like security practices, policies, procedures, compliance information, etc.) AND you feel the data gathering was complete and correct, then create a **SOC2 Policy Document**.

2. **Inquiry/Question Conversation**: If the conversation was about answering questions, clearing doubts, providing information, or general inquiry, then create a **normal summary document**.

DECISION LOGIC:
- First, determine the conversation type
- If it's data gathering AND complete → Create SOC2 Policy Document
- Otherwise → Create normal summary document

FOR SOC2 POLICY DOCUMENT:
Write a professional SOC2 policy document in Markdown format that:
- Is structured as a formal policy document
- Includes relevant sections based on the data gathered (e.g., Access Control, Data Protection, Incident Response, etc.)
- Uses professional policy language
- Formats it as a policy document with proper sections, subsections, and formatting
- Reflects the information gathered during the conversation

FOR NORMAL SUMMARY DOCUMENT:
Write a professional document in Markdown format that:
- Reflects your role and purpose (based on the system prompt)
- Captures the key information, insights, and outcomes from the conversation
- Uses professional language and structure
- Formats it however you think is best - use headings, lists, tables, emphasis, or any other Markdown features

IMPORTANT - Do NOT include in either document:
- References to "Agent" or "User" as participants
- A "Participants" section
- A "Meeting Summary" format
- Conversation-style formatting

Write the document as if you (the agent) are creating a professional document based on the conversation. Use Markdown features creatively to make it clear, professional, and well-organized.

FILENAME GENERATION:
After writing the document, suggest a professional filename for this document. The filename should:
- Be descriptive and reflect the document's content
- Use lowercase letters, numbers, hyphens, and underscores only
- Be concise (max 50 characters)
- Have no spaces (use hyphens instead)
- End with .md extension
- Example: "soc2-access-control-policy.md" or "network-security-assessment.md"

Format your response as:
DOCUMENT:
[Your markdown document here]

FILENAME:
[Suggested filename here]`;

    // Check if OpenAI API key is available
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      console.log('   ⚠️  OPENAI_API_KEY not found, using simple markdown formatting');
      // Fallback: simple markdown formatting
      const fallbackMarkdown = `# Document

**Date:** ${new Date().toLocaleDateString()}

## Overview

${transcriptText}

---
*Generated: ${new Date().toISOString()}*
`;
      return {
        markdown: fallbackMarkdown,
        filename: null // No AI-generated filename in fallback
      };
    }
    
    // Call OpenAI API - no JSON format constraint, let it generate markdown freely
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Using mini for cost efficiency
        messages: [
          {
            role: 'system',
            content: `You are a professional document writer. ${agentDetails ? `You are the agent with this purpose: ${agentDetails.system_prompt || ''}` : ''} 

Analyze conversations and determine the type:
1. If it's data gathering from an employee (security practices, policies, compliance info) AND the data is complete/correct → Create a SOC2 Policy Document
2. If it's inquiry/questions/doubts → Create a normal summary document

Write professional documents in Markdown format. Do NOT write meeting summaries or include participant lists. Write as if you are creating a professional document from your perspective. Use Markdown features creatively.

IMPORTANT: Format your response as:
DOCUMENT:
[Your markdown document here]

FILENAME:
[Suggested filename - lowercase, hyphens, max 50 chars, no .md extension]

Return both the document and filename in this format.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7
        // No response_format constraint - let it generate markdown freely
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    const fullResponse = data.choices[0].message.content.trim();
    
    // Parse the response to extract document and filename
    let markdownContent = fullResponse;
    let suggestedFilename = null;
    
    // Check if response contains FILENAME section
    const filenameMatch = fullResponse.match(/FILENAME:\s*(.+?)(?:\n|$)/i);
    if (filenameMatch) {
      suggestedFilename = filenameMatch[1].trim();
      // Remove FILENAME section from markdown
      markdownContent = fullResponse.replace(/FILENAME:.*$/im, '').trim();
    }
    
    // Check if response contains DOCUMENT section
    const documentMatch = markdownContent.match(/DOCUMENT:\s*(.+)/is);
    if (documentMatch) {
      markdownContent = documentMatch[1].trim();
    }
    
    // Remove markdown code fences (```) from start and end if present
    markdownContent = markdownContent.replace(/^```(?:markdown)?\s*\n?/i, ''); // Remove opening ```
    markdownContent = markdownContent.replace(/\n?```\s*$/i, ''); // Remove closing ```
    markdownContent = markdownContent.trim(); // Trim any extra whitespace
    
    // Sanitize filename if provided
    if (suggestedFilename) {
      // Remove .md extension if present (we'll add it)
      suggestedFilename = suggestedFilename.replace(/\.md$/i, '');
      // Sanitize: lowercase, replace spaces with hyphens, remove special chars
      suggestedFilename = suggestedFilename
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-_]/g, '')
        .substring(0, 50); // Max 50 chars
    }
    
    // Add footer with timestamp
    const finalMarkdown = `${markdownContent}\n\n---\n\n*Generated: ${new Date().toISOString()}*\n`;
    
    console.log(`   ✅ [LLM] Markdown document generated successfully (${finalMarkdown.length} characters)`);
    if (suggestedFilename) {
      console.log(`   📝 Suggested filename: ${suggestedFilename}.md`);
    }
    
    return {
      markdown: finalMarkdown,
      filename: suggestedFilename
    };
    
  } catch (error) {
    console.error(`❌ [LLM] Error generating markdown:`, error);
    // Fallback to simple markdown formatting
    const transcriptText = cleanedTranscript.map(item => {
      if (item.role === 'agent') {
        return item.original_message || '';
      } else if (item.role === 'user') {
        return item.message || '';
      }
      return JSON.stringify(item);
    }).join('\n\n');
    
    return `# Document

**Date:** ${new Date().toLocaleDateString()}

## Overview

${transcriptText}

---
*Generated: ${new Date().toISOString()}*
`;
  }
}

/**
 * Create PDF from formatted content
 */
async function createPDF(formattedContent) {
  try {
    console.log(`\n📝 [PDF] Creating PDF document...`);
    console.log(`   Formatted content structure:`, JSON.stringify(formattedContent, null, 2));
    
    // For now, create a simple text-based PDF
    // In production, use pdf-lib for proper PDF generation
    try {
      const PDFDocument = require('pdf-lib').PDFDocument;
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]); // US Letter size
      
      // Embed fonts once
      const helveticaFont = await pdfDoc.embedFont('Helvetica');
      const helveticaBoldFont = await pdfDoc.embedFont('Helvetica-Bold');
      
      const { width, height } = page.getSize();
      const fontSize = 12;
      let yPosition = height - 50;
      let currentPage = page;
      
      // Helper function to add text
      const addText = (text, size = fontSize, bold = false) => {
        if (!text || text.toString().trim() === '') return; // Skip empty text
        
        if (yPosition < 50) {
          currentPage = pdfDoc.addPage([612, 792]);
          yPosition = height - 50;
        }
        
        // Truncate text if too long to fit on page
        const maxWidth = width - 100;
        const textStr = text.toString();
        
        currentPage.drawText(textStr, {
          x: 50,
          y: yPosition,
          size: size,
          font: bold ? helveticaBoldFont : helveticaFont,
          maxWidth: maxWidth
        });
        yPosition -= size + 10;
      };
    
      // Add header
      if (formattedContent.header) {
        addText(formattedContent.header, 18, true);
        yPosition -= 10;
      } else {
        addText('Meeting Document', 18, true);
        yPosition -= 10;
      }
      
      // Add date
      if (formattedContent.date) {
        addText(`Date: ${new Date(formattedContent.date).toLocaleDateString()}`, 10);
        yPosition -= 5;
      } else {
        addText(`Date: ${new Date().toLocaleDateString()}`, 10);
        yPosition -= 5;
      }
      
      // Add participants
      if (formattedContent.participants && Array.isArray(formattedContent.participants) && formattedContent.participants.length > 0) {
        addText('Participants:', 14, true);
        formattedContent.participants.forEach(participant => {
          addText(`- ${participant}`, fontSize);
        });
        yPosition -= 10;
      }
      
      // Add discussion - handle both string and object formats
      if (formattedContent.discussion) {
        addText('Discussion:', 14, true);
        if (typeof formattedContent.discussion === 'string') {
          const discussionLines = formattedContent.discussion.split('\n');
          discussionLines.forEach(line => {
            if (line.trim()) {
              addText(line.trim(), fontSize);
            }
          });
        } else {
          addText(JSON.stringify(formattedContent.discussion, null, 2), fontSize);
        }
        yPosition -= 10;
      }
      
      // Add action items
      if (formattedContent.action_items && Array.isArray(formattedContent.action_items) && formattedContent.action_items.length > 0) {
        addText('Action Items:', 14, true);
        formattedContent.action_items.forEach(item => {
          addText(`- ${item}`, fontSize);
        });
        yPosition -= 10;
      }
      
      // Add next steps
      if (formattedContent.next_steps && Array.isArray(formattedContent.next_steps) && formattedContent.next_steps.length > 0) {
        addText('Next Steps:', 14, true);
        formattedContent.next_steps.forEach(step => {
          addText(`- ${step}`, fontSize);
        });
        yPosition -= 10;
      }
      
      // Add additional notes
      if (formattedContent.additional_notes) {
        addText('Additional Notes:', 14, true);
        if (typeof formattedContent.additional_notes === 'string') {
          const noteLines = formattedContent.additional_notes.split('\n');
          noteLines.forEach(line => {
            if (line.trim()) {
              addText(line.trim(), fontSize);
            }
          });
        } else {
          addText(JSON.stringify(formattedContent.additional_notes, null, 2), fontSize);
        }
      }
      
      // Fallback: If no structured content, add all content as text
      const hasStructuredContent = formattedContent.header || formattedContent.executive_summary || 
                                   formattedContent.key_discussion_points || formattedContent.discussion ||
                                   (formattedContent.participants && formattedContent.participants.length > 0);
      
      if (!hasStructuredContent) {
        console.log('   ⚠️  No structured content found, adding all content as text');
        addText('Meeting Transcript', 18, true);
        yPosition -= 10;
        
        // Add all properties from formattedContent
        Object.keys(formattedContent).forEach(key => {
          const value = formattedContent[key];
          if (value !== null && value !== undefined && value !== '') {
            addText(`${key}:`, 14, true);
            if (typeof value === 'string') {
              const lines = value.split('\n');
              lines.forEach(line => {
                if (line.trim()) addText(line.trim(), fontSize);
              });
            } else if (Array.isArray(value)) {
              value.forEach(item => addText(`- ${item}`, fontSize));
            } else {
              addText(JSON.stringify(value, null, 2), fontSize);
            }
            yPosition -= 5;
          }
        });
      }
      
      // Always add a footer with timestamp
      yPosition = 30;
      addText(`Generated: ${new Date().toISOString()}`, 8);
      
      // Verify we added content
      const pageCount = pdfDoc.getPageCount();
      console.log(`   📄 PDF pages created: ${pageCount}`);
      if (pageCount === 0 || yPosition === height - 50) {
        console.log('   ⚠️  WARNING: PDF appears to be empty, adding default content');
        addText('Meeting Document', 18, true);
        addText('No content was generated. Please check the transcript and LLM response.', fontSize);
      }
    
      const pdfBytes = await pdfDoc.save();
      console.log(`   ✅ [PDF] PDF created (${pdfBytes.length} bytes)`);
      return pdfBytes;
      
    } catch (error) {
      // Fallback: If pdf-lib is not installed, create a simple text file
      console.log(`   ⚠️  pdf-lib not available, creating text file instead`);
      const textContent = JSON.stringify(formattedContent, null, 2);
      return Buffer.from(textContent, 'utf-8');
    }
  } catch (error) {
    console.error(`❌ [PDF] Error creating PDF:`, error);
    throw error;
  }
}

/**
 * Upload file to Supabase storage
 */
async function uploadToSupabase(fileBuffer, conversationId, fileType = 'pdf', customFileName = null) {
  try {
    const fileExtension = fileType === 'md' ? 'md' : 'pdf';
    const contentType = fileType === 'md' ? 'text/markdown' : 'application/pdf';
    const fileTypeName = fileType === 'md' ? 'Markdown' : 'PDF';
    
    console.log(`\n☁️  [SUPABASE] Uploading ${fileTypeName} to Supabase...`);
    
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase credentials not configured (SUPABASE_URL and SUPABASE_SERVICE_KEY required)');
    }
    
    // Use custom filename if provided, otherwise generate default
    const fileName = customFileName || `meeting-${conversationId}-${Date.now()}.${fileExtension}`;
    const bucketName = process.env.SUPABASE_BUCKET || 'meeting-documents';
    
    // Upload to Supabase storage
    const uploadResponse = await fetch(`${supabaseUrl}/storage/v1/object/${bucketName}/${fileName}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': contentType,
        'x-upsert': 'false'
      },
      body: fileBuffer
    });
    
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Supabase upload failed: ${uploadResponse.status} - ${errorText}`);
    }
    
    // Get public URL
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucketName}/${fileName}`;
    
    console.log(`   ✅ [SUPABASE] ${fileTypeName} uploaded successfully: ${publicUrl}`);
    return publicUrl;
    
  } catch (error) {
    console.error(`❌ [SUPABASE] Error uploading to Supabase:`, error);
    throw error;
  }
}

/**
 * Main function: Process transcript to document
 */
async function processTranscriptToDocument(cleanedTranscript, conversationId) {
  try {
    console.log(`\n🚀 [DOCUMENT] Starting document generation for conversation: ${conversationId}`);
    console.log(`   Transcript messages: ${cleanedTranscript.length}`);
    
    // Step 1: Fetch agent details to get system prompt
    const agentId = process.env.AGENT_ID;
    const agentDetails = agentId ? await getAgentDetails(agentId) : null;
    if (agentDetails) {
      console.log(`   Agent context loaded: ${agentDetails.name || 'Unknown'}`);
    }
    
    // Step 2: Generate markdown document directly using LLM (with agent context)
    const result = await generateMarkdownDocument(cleanedTranscript, agentDetails);
    const markdownContent = result.markdown || result; // Handle both old and new format
    const suggestedFilename = result.filename;
    
    console.log(`\n📝 [DOCUMENT] Markdown document generated`);
    console.log(`   Content length: ${markdownContent.length} characters`);
    console.log(`   Content preview:`, markdownContent.substring(0, 500));
    if (suggestedFilename) {
      console.log(`   AI suggested filename: ${suggestedFilename}.md`);
    }
    
    // Step 3: Generate filename (use AI suggestion or fallback to conversation-based name)
    let fileName;
    if (suggestedFilename) {
      fileName = `${suggestedFilename}-${conversationId.substring(0, 8)}.md`;
    } else {
      // Fallback: generate a simple name based on conversation ID and date
      const dateStr = new Date().toISOString().split('T')[0];
      fileName = `document-${conversationId.substring(0, 8)}-${dateStr}.md`;
    }
    
    console.log(`   Final filename: ${fileName}`);
    
    // Step 4: Upload Markdown to Supabase with custom filename
    const markdownUrl = await uploadToSupabase(Buffer.from(markdownContent, 'utf-8'), conversationId, 'md', fileName);
    
    console.log(`\n✅ [DOCUMENT] Document generation complete`);
    console.log(`   Markdown: ${markdownUrl}`);
    
    return {
      markdown_url: markdownUrl,
      filename: fileName
    };
    
  } catch (error) {
    console.error(`\n❌ [DOCUMENT] Error in document generation:`, error);
    throw error;
  }
}

// ============================================================================
// Webhook Endpoint
// ============================================================================

// Middleware to capture raw body for HMAC verification
const webhookRawBodyParser = express.raw({ type: 'application/json' });

// Webhook endpoint for post-call transcription (ElevenLabs post-call webhook)
app.post('/webhook/elevenlabs', webhookRawBodyParser, async (req, res) => {
  try {
    console.log('\n📥 [WEBHOOK] Received post-call webhook request');
    console.log('   Headers:', JSON.stringify(req.headers, null, 2));
    
    // Get raw body as string for signature verification
    const rawBodyString = req.body.toString();
    
    // Parse the JSON body
    let webhookData;
    try {
      webhookData = JSON.parse(rawBodyString);
      console.log('   Body:', JSON.stringify(webhookData, null, 2));
    } catch (parseError) {
      console.error('   ❌ Failed to parse webhook body:', parseError);
      console.error('   Raw body:', rawBodyString.substring(0, 200));
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    
    // Verify HMAC signature
    const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('   ❌ ELEVENLABS_WEBHOOK_SECRET not found in environment variables');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    
    // ElevenLabs signature format: "t=timestamp,v0=signature"
    const signatureHeader = req.headers['elevenlabs-signature'] || req.headers['xi-signature'];
    
    if (!signatureHeader) {
      console.log('   ⚠️  No signature header found - proceeding without verification');
      // In production, you might want to reject, but for now we'll log and continue
    } else {
      // Parse ElevenLabs signature format: "t=timestamp,v0=signature"
      const signatureParts = signatureHeader.split(',');
      const timestampPart = signatureParts.find(p => p.startsWith('t='));
      const signaturePart = signatureParts.find(p => p.startsWith('v0='));
      
      if (!signaturePart || !timestampPart) {
        console.error('   ❌ Invalid signature format');
        return res.status(401).json({ error: 'Invalid signature format' });
      }
      
      const timestamp = timestampPart.split('=')[1].trim();
      const providedSignature = signaturePart.split('=')[1].trim();
      
      // Validate timestamp (prevent replay attacks - allow 30 minutes tolerance)
      const tolerance = 30 * 60 * 1000; // 30 minutes in milliseconds
      const currentTime = Date.now();
      const requestTime = parseInt(timestamp, 10) * 1000;
      
      if (Math.abs(currentTime - requestTime) > tolerance) {
        console.error(`   ❌ Timestamp outside tolerance zone (${Math.abs(currentTime - requestTime) / 1000}s difference)`);
        return res.status(401).json({ error: 'Timestamp outside tolerance zone' });
      }
      
      // Create HMAC signature using ElevenLabs format: HMAC-SHA256(timestamp + "." + body, secret)
      const payload = `${timestamp}.${rawBodyString}`;
      const hmac = crypto.createHmac('sha256', webhookSecret);
      hmac.update(payload);
      const expectedSignature = hmac.digest('hex');
      
      // Compare signatures using timing-safe comparison (both are hex strings)
      const isValid = crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(providedSignature, 'hex')
      );
      
      if (!isValid) {
        console.error('   ❌ Invalid HMAC signature - webhook rejected');
        console.error(`   Expected: ${expectedSignature.substring(0, 20)}...`);
        console.error(`   Provided: ${providedSignature.substring(0, 20)}...`);
        return res.status(401).json({ error: 'Invalid signature' });
      }
      
      console.log('   ✅ HMAC signature verified');
    }
    
    // Extract data from webhook payload structure
    // Post-call webhook format: { event: { type: "post_call_transcription", data: {...} } }
    const eventData = webhookData.event?.data || webhookData.data || webhookData;
    const conversationId = eventData.conversation_id || eventData.conversationId;
    const transcript = eventData.transcript;
    const analysis = eventData.analysis;
    const metadata = eventData.metadata;
    
    if (!conversationId) {
      console.log('   ⚠️  No conversation_id found in webhook payload');
      console.log('   Payload structure:', JSON.stringify(webhookData, null, 2));
      return res.status(400).json({ 
        error: 'conversation_id is required',
        received_structure: webhookData
      });
    }
    
    console.log(`\n✅ [WEBHOOK] Post-call webhook received`);
    console.log(`   Conversation ID: ${conversationId}`);
    console.log(`   Transcript length: ${transcript ? transcript.length : 0} characters`);
    console.log(`   Has analysis: ${analysis ? 'Yes' : 'No'}`);
    console.log(`   Timestamp: ${new Date().toISOString()}`);
    
    // Clean the transcript
    let cleanedTranscript = null;
    if (transcript) {
      if (Array.isArray(transcript)) {
        cleanedTranscript = transcript.map(item => {
          if (item.role === 'agent') {
            return {
              role: item.role,
              original_message: item.original_message
            };
          } else if (item.role === 'user') {
            return {
              role: item.role,
              message: item.message
            };
          } else {
            // Keep other roles as-is or skip them
            return item;
          }
        });
        
        console.log(`\n🧹 [TRANSCRIPT] Cleaned transcript (${cleanedTranscript.length} messages)`);
        console.log(JSON.stringify(cleanedTranscript, null, 2));
      } else {
        console.log(`\n⚠️  [TRANSCRIPT] Transcript is not an array, keeping as-is`);
        cleanedTranscript = transcript;
      }
    } else {
      console.log(`\n⚠️  [TRANSCRIPT] No transcript found in webhook payload`);
    }
    
    // Process transcript → PDF → Supabase (async, don't block webhook response)
    if (cleanedTranscript) {
      processTranscriptToDocument(cleanedTranscript, conversationId)
        .then(fileUrl => {
          console.log(`\n✅ [DOCUMENT] Successfully created and uploaded: ${fileUrl}`);
        })
        .catch(error => {
          console.error(`\n❌ [DOCUMENT] Error processing transcript:`, error);
        });
    }
    
    // Return success response immediately (webhook best practice)
    res.status(200).json({ 
      success: true,
      message: 'Webhook received and verified successfully',
      conversation_id: conversationId,
      transcript_received: !!transcript,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ [WEBHOOK] Error processing webhook:', error);
    res.status(500).json({ 
      error: 'Failed to process webhook',
      details: error.message 
    });
  }
});

// Test endpoint for webhook (manual testing)
app.post('/webhook/test', (req, res) => {
  console.log('\n🧪 [TEST] Manual webhook test received');
  console.log('   Body:', JSON.stringify(req.body, null, 2));
  res.json({ 
    success: true, 
    message: 'Test endpoint working!',
    received: req.body 
  });
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

