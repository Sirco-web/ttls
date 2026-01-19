# Voice ⇄ Text Room

A lightweight Node.js server + web app for text chat rooms with **server-side speech-to-text** (Whisper) and optional text-to-speech (Piper).

- **5-digit room codes** for quick sharing
- **Push-to-talk recording** → server transcription → text message
- **High-accuracy STT** via Whisper (runs locally on server)
- **Low data usage**: audio is compressed (Opus/WebM) before upload
- Only text messages go over WebSocket

## Quick Start

```bash
npm install
npm start
```

Open: `http://localhost:3000`

> ⚠️ **STT requires additional setup** (see below). Without it, the mic button will show an error.

---

## Server-Side STT Setup

The server transcribes audio using Whisper. Choose **one** backend:

### Option A: whisper.cpp (Recommended)

Fast C++ implementation. Best for CPU-only servers.

1. **Build whisper.cpp**:
   ```bash
   git clone https://github.com/ggerganov/whisper.cpp.git
   cd whisper.cpp
   make
   ```

2. **Download a model**:
   ```bash
   # In whisper.cpp directory
   bash ./models/download-ggml-model.sh base.en
   # Or: tiny.en, small.en, medium.en for different speed/accuracy tradeoffs
   ```

3. **Set environment variables**:
   ```bash
   export WHISPER_BIN=/path/to/whisper.cpp/main
   export WHISPER_MODEL=/path/to/whisper.cpp/models/ggml-base.en.bin
   export WHISPER_LANG=en  # optional, default: en
   ```

4. **Run the server**:
   ```bash
   npm start
   ```

### Option B: faster-whisper (Python)

Python implementation using CTranslate2. Good GPU support.

1. **Install faster-whisper**:
   ```bash
   pip install faster-whisper
   ```

2. **Enable Python STT**:
   ```bash
   export USE_PYTHON_STT=1
   export WHISPER_MODEL_SIZE=base  # tiny, base, small, medium, large-v2
   export WHISPER_DEVICE=cpu       # cpu, cuda, auto
   export WHISPER_COMPUTE=int8     # int8, float16, float32
   export WHISPER_LANG=en
   ```

3. **Run the server**:
   ```bash
   npm start
   ```

   The first run downloads the model automatically.

---

## Prerequisites

- **Node.js** 18+
- **ffmpeg** (for audio conversion)
  ```bash
  # Ubuntu/Debian
  sudo apt install ffmpeg
  
  # macOS
  brew install ffmpeg
  
  # Windows
  choco install ffmpeg
  ```
- **One Whisper backend** (see above)

---

## Optional: Server-Side TTS (Piper)

For offline text-to-speech synthesis:

1. **Download Piper**:
   - Get binaries from: https://github.com/rhasspy/piper/releases
   - Download a voice model (`.onnx` + `.onnx.json`)

2. **Set environment variables**:
   ```bash
   export PIPER_BIN=/path/to/piper
   export PIPER_MODEL=/path/to/en_US-lessac-medium.onnx
   ```

3. The speaker button will use server TTS; falls back to browser TTS if not configured.

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `WHISPER_BIN` | Path to whisper.cpp `main` binary | (none) |
| `WHISPER_MODEL` | Path to `.bin` model file | (none) |
| `WHISPER_LANG` | Language code | `en` |
| `USE_PYTHON_STT` | Set to `1` to use faster-whisper | `0` |
| `WHISPER_MODEL_SIZE` | Model size for faster-whisper | `base` |
| `WHISPER_DEVICE` | Device for faster-whisper | `cpu` |
| `WHISPER_COMPUTE` | Compute type for faster-whisper | `int8` |
| `PIPER_BIN` | Path to Piper binary | (none) |
| `PIPER_MODEL` | Path to Piper `.onnx` model | (none) |

---

## API Endpoints

### `POST /api/stt`

Transcribe audio to text.

- **Content-Type**: `multipart/form-data`
- **Field**: `audio` (WebM/Ogg Opus blob)
- **Max size**: 8MB
- **Max duration**: ~20 seconds

**Response**:
```json
{ "text": "transcribed text here" }
```

**Errors**:
- `400` - Bad request (no audio, too long)
- `413` - File too large
- `429` - Rate limited
- `500` - Server/transcription error

### `POST /api/tts`

Synthesize speech from text (requires Piper setup).

- **Content-Type**: `application/json`
- **Body**: `{ "text": "Hello world" }`
- **Max text**: 2000 characters

**Response**: `audio/wav` stream

---

## Troubleshooting

### "Whisper not configured"
Set `WHISPER_BIN` and `WHISPER_MODEL` environment variables, or enable Python STT with `USE_PYTHON_STT=1`.

### "Audio conversion failed"
Ensure `ffmpeg` is installed and in PATH:
```bash
ffmpeg -version
```

### "Transcription failed"
- Check that the Whisper binary/model paths are correct
- Check server logs for detailed error messages
- For whisper.cpp: ensure the model file matches the binary version

### Recording doesn't work
- Browser must be on HTTPS or localhost
- Grant microphone permission when prompted
- Check browser console for errors

### Slow transcription
- Use a smaller model (`tiny.en` or `base.en`)
- For faster-whisper with GPU: set `WHISPER_DEVICE=cuda`

---

## How It Works

1. User holds mic button → browser records audio as Opus/WebM
2. On release, compressed audio blob is uploaded to `/api/stt`
3. Server converts to 16kHz mono WAV using ffmpeg
4. Whisper transcribes the audio
5. Server returns `{ text }` → client fills textbox
6. User sends message through existing WebSocket flow

---

## Security Notes

- Rate limiting: 30 requests/minute per IP
- File size limit: 8MB
- Duration limit: ~20 seconds
- Temp files are cleaned up after processing
- No audio is stored permanently

---

## File Layout

- `server.js` — Express + WebSocket server with STT/TTS endpoints
- `stt.py` — Python script for faster-whisper backend
- `public/` — Frontend (`index.html`, `app.js`, `style.css`)

---

## License

MIT
