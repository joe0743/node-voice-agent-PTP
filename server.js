/**
 * Node Voice Agent Starter - Backend Server
 *
 * Simple WebSocket proxy to Deepgram's Voice Agent API.
 * Forwards all messages (JSON and binary) bidirectionally between client and Deepgram.
 */

const { WebSocketServer, WebSocket } = require('ws');
const express = require('express');
const { createServer } = require('http');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const toml = require('toml');

// Validate required environment variables
if (!process.env.DEEPGRAM_API_KEY) {
  console.error('ERROR: DEEPGRAM_API_KEY environment variable is required');
  process.exit(1);
}

// Configuration
const CONFIG = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  deepgramAgentUrl: 'wss://agent.deepgram.com/v1/agent/converse',
  port: process.env.PORT || 8081,
  host: process.env.HOST || '0.0.0.0',
};

// JWT setup
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = '1h';

function validateWsToken(protocols) {
  if (!protocols) return null;
  const list = Array.isArray(protocols)
    ? protocols
    : protocols.split(',').map(s => s.trim());
  const tokenProto = list.find(p => p.startsWith('access_token.'));
  if (!tokenProto) return null;
  const token = tokenProto.slice('access_token.'.length);
  try {
    jwt.verify(token, SESSION_SECRET);
    return tokenProto;
  } catch {
    return null;
  }
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    for (const proto of protocols) {
      if (proto.startsWith('access_token.')) return proto;
    }
    return false;
  },
});

const activeConnections = new Set();
app.use(cors());

// Routes
app.get('/api/session', (req, res) => {
  const token = jwt.sign(
    { iat: Math.floor(Date.now() / 1000) },
    SESSION_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
  res.json({ token });
});

app.get('/api/metadata', (req, res) => {
  try {
    const tomlPath = path.join(__dirname, 'deepgram.toml');
    const tomlContent = fs.readFileSync(tomlPath, 'utf-8');
    const config = toml.parse(tomlContent);

    if (!config.meta) {
      return res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Missing [meta] section in deepgram.toml'
      });
    }

    res.json(config.meta);
  } catch (error) {
    console.error('Error reading metadata:', error);
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to read metadata from deepgram.toml'
    });
  }
});

// WebSocket proxy
wss.on('connection', async (clientWs, request) => {
  console.log('Client connected to /api/voice-agent');
  activeConnections.add(clientWs);

  try {
    console.log('Initiating Deepgram connection...');

    // FIXED: Correct WebSocket authentication
    const deepgramWs = new WebSocket(CONFIG.deepgramAgentUrl, {
      headers: {
        Authorization: `Token ${CONFIG.deepgramApiKey}`
      }
    });

    deepgramWs.on('open', () => {
      console.log('✓ Connected to Deepgram Agent API');
    });

    deepgramWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    deepgramWs.on('error', (error) => {
      console.error('Deepgram WebSocket error:', error);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'Error',
          description: error.message || 'Deepgram connection error',
          code: 'PROVIDER_ERROR'
        }));
      }
    });

    deepgramWs.on('close', (code, reason) => {
      console.log(`Deepgram connection closed: ${code} ${reason}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        const reserved = [1004, 1005, 1006, 1015];
        const closeCode = (code >= 1000 && code <= 4999 && !reserved.includes(code))
          ? code
          : 1000;
        clientWs.close(closeCode, reason);
      }
    });

    clientWs.on('message', (data, isBinary) => {
      if (deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(data, { binary: isBinary });
      }
    });

    clientWs.on('close', () => {
      if (deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close();
      activeConnections.delete(clientWs);
    });

    clientWs.on('error', () => {
      if (deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close();
    });

  } catch (error) {
    console.error('Error setting up proxy:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'Error',
        description: 'Failed to establish proxy connection',
        code: 'CONNECTION_FAILED'
      }));
      clientWs.close();
    }
  }
});

// Upgrade handler
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname === '/api/voice-agent' || pathname === '/twilio-stream') {
    const protocols = request.headers['sec-websocket-protocol'];

    if (!protocols) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
      return;
    }

    const validProto = validateWsToken(protocols);
    if (!validProto) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
    return;
  }

  socket.destroy();
});

// Twilio webhook
app.post("/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/api/voice-agent" />
      </Connect>
    </Response>
  `);
});

// Start server
server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`Server running at http://localhost:${CONFIG.port}`);
});
