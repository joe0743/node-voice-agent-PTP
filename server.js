/**
 * Node Voice Agent Starter - Backend Server (Twilio only)
 *
 * Simple WebSocket proxy to Deepgram's Voice Agent API.
 * Forwards all audio bidirectionally between Twilio and Deepgram.
 */

const { WebSocketServer, WebSocket } = require('ws');
const express = require('express');
const { createServer } = require('http');
require('dotenv').config();

// Validate environment variables
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

// ==========================
// Twilio /voice route
// ==========================
app.post("/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/twilio-stream" />
      </Connect>
    </Response>
  `);
});

// ==========================
// WebSocket proxy handler
// ==========================
wss.on('connection', (twilioWs, request) => {
  console.log('Twilio connected');
  activeConnections.add(twilioWs);

  // Connect to Deepgram
  const deepgramWs = new WebSocket(CONFIG.deepgramAgentUrl, `Token ${CONFIG.deepgramApiKey}`);

  deepgramWs.on('open', () => {
    console.log('✓ Connected to Deepgram Agent API');
  });

  // Twilio → Deepgram
  twilioWs.on('message', (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "media") {
      deepgramWs.send(JSON.stringify({
        type: "input_audio",
        audio: data.media.payload
      }));
    }
  });

  // Deepgram → Twilio
  deepgramWs.on('message', (msg) => {
    const data = JSON.parse(msg);
    if (data.type === "output_audio") {
      twilioWs.send(JSON.stringify({
        event: "media",
        media: { payload: data.audio }
      }));
    }
  });

  // Handle disconnects
  twilioWs.on('close', () => {
    console.log('Twilio disconnected');
    if (deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close();
    activeConnections.delete(twilioWs);
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WS error:', err);
    if (deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close();
  });

  deepgramWs.on('close', (code, reason) => {
    console.log(`Deepgram connection closed: ${code} ${reason}`);
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  deepgramWs.on('error', (err) => {
    console.error('Deepgram WS error:', err);
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });
});

// ==========================
// Upgrade HTTP to WS
// ==========================
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/twilio-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ==========================
// Start server
// ==========================
server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`🚀 Twilio-Deepgram server running at http://${CONFIG.host}:${CONFIG.port}`);
  console.log('📡 POST /voice');
  console.log('📡 WS  /twilio-stream');
});
