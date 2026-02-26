const { WebSocketServer, WebSocket } = require("ws");
const express = require("express");
const { createServer } = require("http");
require("dotenv").config();

/*
====================================================
CONFIG
====================================================
*/

if (!process.env.DEEPGRAM_API_KEY) {
  console.error("Missing DEEPGRAM_API_KEY");
  process.exit(1);
}

const CONFIG = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  deepgramAgentUrl: "wss://agent.deepgram.com/v1/agent/converse",
  port: process.env.PORT || 8080,
  host: "0.0.0.0",
};

/*
====================================================
SERVER SETUP
====================================================
*/

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

/*
====================================================
TWILIO VOICE ENTRY POINT
====================================================
*/

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

/*
====================================================
WEBSOCKET STREAM HANDLER
====================================================
*/

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  const deepgramWs = new WebSocket(
    CONFIG.deepgramAgentUrl,
    `Token ${CONFIG.deepgramApiKey}`
  );

  // Twilio → Deepgram
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === "media") {
        deepgramWs.send(
          JSON.stringify({
            type: "input_audio",
            audio: data.media.payload,
          })
        );
      }
    } catch (err) {
      console.error("Twilio message parse error:", err);
    }
  });

  // Deepgram → Twilio
  deepgramWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === "output_audio") {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            media: { payload: data.audio },
          })
        );
      }
    } catch (err) {
      console.error("Deepgram message error:", err);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio disconnected");
    deepgramWs.close();
  });

  deepgramWs.on("close", () => {
    twilioWs.close();
  });
});

/*
====================================================
UPGRADE HANDLER (IMPORTANT FIX)
====================================================
*/

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(
    request.url,
    `http://${request.headers.host}`
  ).pathname;

  if (pathname === "/twilio-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
    return;
  }

  socket.destroy();
});

/*
====================================================
START SERVER
====================================================
*/

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`🚀 Server running on http://${CONFIG.host}:${CONFIG.port}`);
  console.log("POST /voice");
  console.log("WS /twilio-stream");
});
