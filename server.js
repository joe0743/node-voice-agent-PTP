const { WebSocketServer, WebSocket } = require("ws");
const express = require("express");
const { createServer } = require("http");
require("dotenv").config();

if (!process.env.DEEPGRAM_API_KEY) {
  console.error("Missing DEEPGRAM_API_KEY");
  process.exit(1);
}

const CONFIG = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  deepgramAgentUrl: "wss://agent.deepgram.com/v1/agent/converse",
  port: process.env.PORT || 8080,
};

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

/*
====================================================
Twilio Voice Webhook
====================================================
*/
app.post("/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/twilio-stream"/>
  </Connect>
</Response>
  `);
});

/*
====================================================
WebSocket Streaming Bridge
====================================================
*/
wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  const deepgramWs = new WebSocket(
    CONFIG.deepgramAgentUrl,
    {
      headers: {
        Authorization: `Token ${CONFIG.deepgramApiKey}`,
      },
    }
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
    } catch (e) {}
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
    } catch (e) {}
  });

  twilioWs.on("close", () => deepgramWs.close());
  deepgramWs.on("close", () => twilioWs.close());
});

/*
====================================================
Upgrade Handler (Critical Fix)
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
Start Server
====================================================
*/
server.listen(CONFIG.port, "0.0.0.0", () => {
  console.log(`Server running on port ${CONFIG.port}`);
  console.log("POST /voice");
  console.log("WS /twilio-stream");
});
