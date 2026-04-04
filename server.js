/**
 * Node Voice Agent Starter - Twilio-Only Backend Server
 *
 * Simple WebSocket proxy to Deepgram's Voice Agent API.
 * Forwards all messages (JSON and binary) bidirectionally between Twilio and Deepgram.
 */

const { WebSocketServer, WebSocket } = require('ws');
const express = require('express');
const { createServer } = require('http');
require('dotenv').config();
const cors = require('cors');

if (!process.env.DEEPGRAM_API_KEY) {
  console.error('ERROR: DEEPGRAM_API_KEY environment variable is required');
  process.exit(1);
}

const CONFIG = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  deepgramAgentUrl: 'wss://agent.deepgram.com/v1/agent/converse',
  port: process.env.PORT || 8080,
  host: process.env.HOST || '0.0.0.0',
};

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const activeConnections = new Set();

app.use(cors());

// ============================
// Twilio /voice endpoint
// ============================
app.post('/voice', (req, res) => {
  res.type('text/xml');
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/twilio-stream" />
      </Connect>
    </Response>
  `);
});

app.post("/", (req, res) => {
  res.type("text/xml");
  res.send("<Response><Say>Hello from Railway</Say></Response>");
});

// ============================
// WebSocket proxy to Deepgram
// ============================
wss.on('connection', (clientWs) => {
  console.log('Twilio client connected');
  activeConnections.add(clientWs);

  let twilioStreamSid = null;

  // Connect to Deepgram
  const deepgramWs = new WebSocket(CONFIG.deepgramAgentUrl, {
    headers: { Authorization: `Token ${CONFIG.deepgramApiKey}` },
  });

  deepgramWs.on('open', () => {
    console.log('✓ Connected to Deepgram Agent API');

    deepgramWs.send(JSON.stringify({
      type: "Settings",
      audio: {
        input: {
          encoding: "mulaw",
          sample_rate: 8000
        },
        output: {
          encoding: "mulaw",
          sample_rate: 8000
        }
      }
    }));
  });

  // ============================
  // Deepgram → Twilio
  // ============================
  deepgramWs.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.type === 'Welcome' || data.type === 'SettingsApplied') return;

    if (data.type === 'output_audio' && data.audio && clientWs.readyState === WebSocket.OPEN) {
      console.log("✓ Deepgram → Twilio (audio)");
      clientWs.send(JSON.stringify({
        event: 'media',
        streamSid: twilioStreamSid,
        media: { payload: data.audio }
      }));
    }
  });

  deepgramWs.on('error', (err) => {
    console.error('Deepgram WebSocket error:', err);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'Error', description: err.message }));
    }
  });

  deepgramWs.on('close', () => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    console.log('✓ Deepgram closed');
  });

  // ============================
  // Twilio → Deepgram
  // ============================
  clientWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      console.log("TWILIO:", data);

      if (data.event === 'start' && data.start?.streamSid) {
        twilioStreamSid = data.start.streamSid;
        return;
      }

      if (data.event === 'media' && data.media?.payload && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(JSON.stringify({
          type: 'input_audio_buffer',
          audio: data.media.payload
        }));
      }

    } catch (e) {
      console.error('Twilio message parse error', e);
    }
  });

  clientWs.on('close', () => {
    if (deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close();
    activeConnections.delete(clientWs);
    console.log('✓ Twilio closed');
  });

  clientWs.on('error', () => {
    if (deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close();
    console.log('Twilio WS error');
  });
});

// ============================
// Upgrade HTTP → WS for Twilio
// ============================
server.on('upgrade', (request, socket, head) => {
  console.log('✓ Upgrade');
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/twilio-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

// ============================
// Start server
// ============================
server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`🚀 Twilio-Deepgram server running at http://${CONFIG.host}:${CONFIG.port}`);
  console.log('📡 POST /voice');
  console.log('📡 WS /twilio-stream');
});