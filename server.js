const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 3000);
const MAX_MSG_CHARS = 1000;

// STT/TTS configuration (env vars)
const WHISPER_BIN = process.env.WHISPER_BIN || '';       // Path to whisper.cpp main binary
const WHISPER_MODEL = process.env.WHISPER_MODEL || '';   // Path to ggml model file
const WHISPER_LANG = process.env.WHISPER_LANG || 'en';   // Language code
const USE_PYTHON_STT = process.env.USE_PYTHON_STT === '1'; // Use faster-whisper via Python
const PIPER_BIN = process.env.PIPER_BIN || '';           // Path to piper binary
const PIPER_MODEL = process.env.PIPER_MODEL || '';       // Path to piper .onnx model

// Limits
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_AUDIO_DURATION_SEC = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;   // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30;       // per window

// Simple in-memory rate limiter
const rateLimitMap = new Map(); // ip -> { count, windowStart }
function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX_REQUESTS;
}
// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 60 * 1000).unref();

// Temp directory for audio processing
const TEMP_DIR = path.join(os.tmpdir(), 'voice-text-stt');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function randomFileName(ext) {
  return crypto.randomBytes(16).toString('hex') + ext;
}

function cleanupFiles(...files) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch {}
  }
}

const app = express();
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: '1h'
  })
);

app.get('/health', (_req, res) => res.json({ ok: true }));

// ============================================================
// STT Endpoint: POST /api/stt
// Accepts multipart/form-data with "audio" field (webm/ogg opus)
// Returns JSON { text: "transcribed text" }
// ============================================================

// Simple multipart parser (no external dependencies)
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (!match) return reject(new Error('No boundary in content-type'));
    const boundary = match[1] || match[2];

    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        req.destroy();
        return reject(new Error('Upload too large'));
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const boundaryBuffer = Buffer.from('--' + boundary);

      // Find parts
      let start = buffer.indexOf(boundaryBuffer);
      if (start === -1) return reject(new Error('Invalid multipart data'));

      // Find the audio field
      const parts = [];
      while (true) {
        const nextBoundary = buffer.indexOf(boundaryBuffer, start + boundaryBuffer.length);
        if (nextBoundary === -1) break;

        const partData = buffer.slice(start + boundaryBuffer.length, nextBoundary);
        parts.push(partData);
        start = nextBoundary;
      }

      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;

        const headerSection = part.slice(0, headerEnd).toString('utf8');
        const body = part.slice(headerEnd + 4);

        // Check if this is the audio field
        if (headerSection.includes('name="audio"')) {
          // Trim trailing \r\n if present
          let audioData = body;
          if (audioData.length >= 2 && audioData[audioData.length - 2] === 0x0d && audioData[audioData.length - 1] === 0x0a) {
            audioData = audioData.slice(0, -2);
          }
          return resolve(audioData);
        }
      }
      reject(new Error('No audio field found'));
    });

    req.on('error', reject);
  });
}

// Convert audio to WAV using ffmpeg
function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-vn', outputPath];
    execFile('ffmpeg', args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('ffmpeg error:', stderr);
        return reject(new Error('Audio conversion failed'));
      }
      resolve();
    });
  });
}

// Run whisper.cpp
function runWhisperCpp(wavPath) {
  return new Promise((resolve, reject) => {
    if (!WHISPER_BIN || !WHISPER_MODEL) {
      return reject(new Error('Whisper not configured (set WHISPER_BIN and WHISPER_MODEL)'));
    }

    const outBase = wavPath.replace(/\.wav$/, '');
    // whisper.cpp outputs to outBase.txt when using -otxt
    const args = [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '-l', WHISPER_LANG,
      '-otxt',
      '-of', outBase,
      '--no-timestamps'
    ];

    execFile(WHISPER_BIN, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('whisper.cpp error:', stderr);
        return reject(new Error('Whisper transcription failed'));
      }

      const txtPath = outBase + '.txt';
      fs.readFile(txtPath, 'utf8', (readErr, text) => {
        // Cleanup the txt file
        try { fs.unlinkSync(txtPath); } catch {}

        if (readErr) {
          return reject(new Error('Could not read Whisper output'));
        }
        resolve(text.trim());
      });
    });
  });
}

// Run faster-whisper via Python
function runFasterWhisper(wavPath) {
  return new Promise((resolve, reject) => {
    const sttScript = path.join(__dirname, 'stt.py');
    if (!fs.existsSync(sttScript)) {
      return reject(new Error('stt.py not found'));
    }

    const child = spawn('python3', [sttScript, wavPath], { timeout: 120000 });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('faster-whisper error:', stderr);
        return reject(new Error('Whisper transcription failed'));
      }
      try {
        const result = JSON.parse(stdout);
        resolve(result.text || '');
      } catch {
        resolve(stdout.trim());
      }
    });

    child.on('error', (err) => {
      reject(new Error('Failed to run stt.py: ' + err.message));
    });
  });
}

// Main STT handler
app.post('/api/stt', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';

  // Rate limit check
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait.' });
  }

  let inputPath = null;
  let wavPath = null;

  try {
    // Parse multipart data
    const audioBuffer = await parseMultipart(req);

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: 'No audio data received' });
    }

    if (audioBuffer.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: 'Audio file too large (max 8MB)' });
    }

    // Save to temp file
    inputPath = path.join(TEMP_DIR, randomFileName('.webm'));
    wavPath = path.join(TEMP_DIR, randomFileName('.wav'));

    fs.writeFileSync(inputPath, audioBuffer);

    // Convert to WAV
    await convertToWav(inputPath, wavPath);

    // Check WAV file size (rough duration estimate: 16kHz mono 16-bit = 32KB/sec)
    const wavStats = fs.statSync(wavPath);
    const estimatedDuration = wavStats.size / (16000 * 2); // 16-bit = 2 bytes per sample
    if (estimatedDuration > MAX_AUDIO_DURATION_SEC + 5) {
      cleanupFiles(inputPath, wavPath);
      return res.status(400).json({ error: 'Audio too long (max 20 seconds)' });
    }

    // Run Whisper
    let text;
    if (USE_PYTHON_STT) {
      text = await runFasterWhisper(wavPath);
    } else {
      text = await runWhisperCpp(wavPath);
    }

    // Cleanup
    cleanupFiles(inputPath, wavPath);

    res.json({ text: text || '' });

  } catch (err) {
    console.error('STT error:', err.message);
    cleanupFiles(inputPath, wavPath);

    if (err.message === 'Upload too large') {
      return res.status(413).json({ error: 'Audio file too large (max 8MB)' });
    }
    res.status(500).json({ error: err.message || 'Transcription failed' });
  }
});

// ============================================================
// TTS Endpoint: POST /api/tts (optional)
// Accepts JSON { text: "..." }
// Returns audio/wav
// ============================================================

app.post('/api/tts', express.json({ limit: '10kb' }), async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait.' });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'No text provided' });
  }

  if (text.length > 2000) {
    return res.status(400).json({ error: 'Text too long (max 2000 chars)' });
  }

  if (!PIPER_BIN || !PIPER_MODEL) {
    return res.status(501).json({ error: 'TTS not configured (set PIPER_BIN and PIPER_MODEL)' });
  }

  let wavPath = null;

  try {
    wavPath = path.join(TEMP_DIR, randomFileName('.wav'));

    // Piper reads from stdin and writes to output file
    await new Promise((resolve, reject) => {
      const child = spawn(PIPER_BIN, [
        '--model', PIPER_MODEL,
        '--output_file', wavPath
      ]);

      child.stdin.write(text.trim());
      child.stdin.end();

      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data; });

      child.on('close', (code) => {
        if (code !== 0) {
          console.error('Piper error:', stderr);
          return reject(new Error('TTS synthesis failed'));
        }
        resolve();
      });

      child.on('error', (err) => {
        reject(new Error('Failed to run Piper: ' + err.message));
      });
    });

    // Stream the WAV file
    res.setHeader('Content-Type', 'audio/wav');
    const stream = fs.createReadStream(wavPath);
    stream.pipe(res);
    stream.on('close', () => {
      cleanupFiles(wavPath);
    });
    stream.on('error', () => {
      cleanupFiles(wavPath);
    });

  } catch (err) {
    console.error('TTS error:', err.message);
    cleanupFiles(wavPath);
    res.status(500).json({ error: err.message || 'TTS failed' });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  // Keep payload small (text messages only)
  maxPayload: 64 * 1024
});

/**
 * Rooms: Map<roomCode, { clients: Map<clientId, { ws, name }>, createdAt: number }>
 */
const rooms = new Map();

function randId(len = 8) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function makeRoomCode() {
  // 5 digits
  let code = '';
  for (let i = 0; i < 5; i++) code += String(Math.floor(Math.random() * 10));
  return code;
}

function createRoom() {
  for (let i = 0; i < 10000; i++) {
    const code = makeRoomCode();
    if (!rooms.has(code)) {
      rooms.set(code, { clients: new Map(), createdAt: Date.now() });
      return code;
    }
  }
  throw new Error('Could not create room');
}

function roomSnapshot(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  const users = [...room.clients.entries()].map(([id, c]) => ({ id, name: c.name }));
  return { room: roomCode, users, count: users.length };
}

function safeText(s) {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim();
  if (!trimmed) return '';
  return trimmed.slice(0, MAX_MSG_CHARS);
}

function send(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(roomCode, obj) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const msg = JSON.stringify(obj);
  for (const { ws } of room.clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function cleanupEmptyRooms() {
  for (const [code, room] of rooms.entries()) {
    if (room.clients.size === 0) rooms.delete(code);
  }
}
setInterval(cleanupEmptyRooms, 60 * 1000).unref();

wss.on('connection', (ws) => {
  const clientId = randId(10);
  let joinedRoom = null;
  let clientName = 'User';

  // Tell the client their ID right away
  send(ws, { type: 'hello', clientId });

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'create') {
      const room = createRoom();
      joinedRoom = room;
      clientName = safeText(msg.name) || 'User';
      const r = rooms.get(room);
      r.clients.set(clientId, { ws, name: clientName });
      send(ws, { type: 'created', room, clientId });
      broadcast(room, { type: 'presence', ...roomSnapshot(room) });
      return;
    }

    if (msg.type === 'join') {
      const room = safeText(msg.room);
      if (!room || room.length !== 5 || !/^[0-9]{5}$/.test(room)) {
        send(ws, { type: 'error', message: 'Room code must be 5 digits.' });
        return;
      }
      const r = rooms.get(room);
      if (!r) {
        send(ws, { type: 'error', message: 'Room not found.' });
        return;
      }

      joinedRoom = room;
      clientName = safeText(msg.name) || 'User';
      r.clients.set(clientId, { ws, name: clientName });
      send(ws, { type: 'joined', room, clientId });
      broadcast(room, { type: 'presence', ...roomSnapshot(room) });
      return;
    }

    if (msg.type === 'leave') {
      if (joinedRoom && rooms.has(joinedRoom)) {
        const r = rooms.get(joinedRoom);
        r.clients.delete(clientId);
        broadcast(joinedRoom, { type: 'presence', ...roomSnapshot(joinedRoom) });
      }
      joinedRoom = null;
      return;
    }

    if (msg.type === 'msg') {
      if (!joinedRoom || !rooms.has(joinedRoom)) {
        send(ws, { type: 'error', message: 'Not in a room.' });
        return;
      }
      const text = safeText(msg.text);
      if (!text) return;
      const payload = {
        type: 'msg',
        room: joinedRoom,
        from: clientId,
        fromName: clientName,
        text,
        ts: Date.now()
      };
      broadcast(joinedRoom, payload);
      return;
    }
  });

  ws.on('close', () => {
    if (joinedRoom && rooms.has(joinedRoom)) {
      const r = rooms.get(joinedRoom);
      r.clients.delete(clientId);
      broadcast(joinedRoom, { type: 'presence', ...roomSnapshot(joinedRoom) });
    }
  });
});

const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Voice-Text Room running on http://${HOST}:${PORT}`);
});
