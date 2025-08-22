//Importing all the required modules
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { GoogleGenerativeAI } = require("@google/generative-ai");

//Configuring the ports
const app = express();
const PORT = process.env.PORT || 3000;

//memory storage for serverless deployment on vercel server
const upload = multer({ storage: multer.memoryStorage() });

//Gemini API key initialization
const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);

//Session Initialization
const sessions = {};

// Track server startup time for uptime calculation
const serverStartTime = Date.now();

//Defining CORS Policy allowed origins for backend
const allowedOrigins = [
  "http://localhost:3000",
  "https://your-vercel-domain.vercel.app",
];

//Error Logging Function
const logError = (message, error) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ${message}:`, error.message);
};

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin like Postman
      if (!origin) return callback(null, true);

      // Check if origin is a Chrome extension (starts with chrome-extension://)
      if (origin.startsWith("chrome-extension://")) {
        return callback(null, true);
      }

      // Check if origin is in allowed origins list
      if (allowedOrigins.indexOf(origin) !== -1) {
        return callback(null, true);
      }

      const msg = `CORS policy does not allow access from origin ${origin}`;
      return callback(new Error(msg), false);
    },
  })
);

//Retry logic with exceptional Backoff
async function retryWithExponentialBackoff(fn, maxAttempts, initialDelay) {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      attempts++;
      logError(`Attempt ${attempts} failed`, error);
      // Check if it's a server-side error that we should retry
      if (error.status === 500 || error.status === 503) {
        if (attempts < maxAttempts) {
          const delay = initialDelay * Math.pow(2, attempts - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } else {
        // For other errors, re-throw immediately
        throw error;
      }
    }
  }
  throw new Error(`Failed after ${maxAttempts} attempts.`);
}

//HEALTH & STATUS APIs

//Basic Health Check
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: Date.now() - serverStartTime,
  });
});

//Detailed Status
app.get("/api/status", async (req, res) => {
  const currentTime = Date.now();
  const uptimeMs = currentTime - serverStartTime;

  // Convert uptime to human readable format
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  const uptimeMinutes = Math.floor(uptimeSeconds / 60);
  const uptimeHours = Math.floor(uptimeMinutes / 60);

  let geminiStatus = "unknown";
  let geminiLatency = null;

  // Test Gemini API connection
  try {
    const testStart = Date.now();
    if (apiKey && genAI) {
      // Quick test of Gemini API availability
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      await model.generateContent({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
      });
      geminiLatency = Date.now() - testStart;
      geminiStatus = "connected";
    } else {
      geminiStatus = "misconfigured";
    }
  } catch (error) {
    geminiStatus = "disconnected";
    geminiLatency = Date.now() - testStart;
  }

  res.status(200).json({
    status: "operational",
    timestamp: new Date().toISOString(),
    uptime: {
      milliseconds: uptimeMs,
      seconds: uptimeSeconds,
      minutes: uptimeMinutes,
      hours: uptimeHours,
      human: `${uptimeHours}h ${uptimeMinutes % 60}m ${uptimeSeconds % 60}s`,
    },
    services: {
      gemini: {
        status: geminiStatus,
        configured: !!apiKey,
        latency: geminiLatency,
      },
    },
    sessions: {
      active: Object.keys(sessions).length,
      total: Object.keys(sessions).length,
    },
    memory: {
      usage: process.memoryUsage(),
    },
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      port: PORT,
    },
  });
});

//Readiness Check
app.get("/api/ready", (req, res) => {
  const isReady = !!apiKey && !!genAI;

  if (isReady) {
    res.status(200).json({
      ready: true,
      message: "Service is ready to accept requests",
    });
  } else {
    res.status(503).json({
      ready: false,
      message: "Service is not ready - missing configuration",
    });
  }
});

//Live Check (Minimal response for load balancers)
app.get("/api/live", (req, res) => {
  res.status(200).send("OK");
});

//Start a new session
app.post("/api/start", (req, res) => {
  const sessionId = uuidv4();
  sessions[sessionId] = { files: [], transcript: "" };
  res.json({ sessionId });
});

//Receive audio chunks
app.post("/api/chunk/:sessionId", upload.single("audio"), async (req, res) => {
  const { sessionId } = req.params;
  if (!sessions[sessionId]) return res.status(404).send("Invalid session");

  try {
    // Use buffer to store and process audio chunks temporarily
    const audioBuffer = req.file.buffer;
    const base64Audio = audioBuffer.toString("base64");

    const prompt = "Transcribe this audio chunk word-for-word.";

    // Wrap the API call in the new retry function
    const result = await retryWithExponentialBackoff(
      async () => {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const response = await model.generateContent({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                { inlineData: { data: base64Audio, mimeType: "audio/webm" } },
              ],
            },
          ],
        });
        return response;
      },
      3,
      1000
    ); // 3 attempts, 1000ms initial delay

    const text = result.response.text() || "";
    sessions[sessionId].transcript += text + " ";
    res.send(text);
  } catch (err) {
    logError("Chunk transcription error", err);
    res.status(500).send("Transcription error");
  }
});

//Stop session and clear the state
app.post("/api/stop/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  if (!sessions[sessionId]) return res.status(404).send("Invalid session");

  //Clear session data
  delete sessions[sessionId];
  res.status(200).send("Recording Stopped Successfully.");
});

// Middleware
app.use(cors());
app.use(express.json());

// Exporting the app for Vercel deployment
module.exports = app;

// Start server for local development
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}
