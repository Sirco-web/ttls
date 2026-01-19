#!/usr/bin/env python3
"""
Server-side STT using faster-whisper.

Usage:
    python3 stt.py <audio.wav>

Output:
    JSON to stdout: {"text": "transcribed text"}

Setup:
    pip install faster-whisper

Environment variables (optional):
    WHISPER_MODEL_SIZE - Model size: tiny, base, small, medium, large-v2 (default: base)
    WHISPER_DEVICE     - Device: cpu, cuda, auto (default: cpu)
    WHISPER_COMPUTE    - Compute type: int8, float16, float32 (default: int8)
    WHISPER_LANG       - Language code: en, es, fr, etc. (default: en)
"""

import sys
import os
import json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: stt.py <audio.wav>"}))
        sys.exit(1)
    
    audio_path = sys.argv[1]
    
    if not os.path.exists(audio_path):
        print(json.dumps({"error": f"File not found: {audio_path}"}))
        sys.exit(1)
    
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper not installed. Run: pip install faster-whisper"}))
        sys.exit(1)
    
    # Configuration from environment
    model_size = os.environ.get("WHISPER_MODEL_SIZE", "base")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("WHISPER_COMPUTE", "int8")
    language = os.environ.get("WHISPER_LANG", "en")
    
    try:
        # Load model (cached after first load)
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        
        # Transcribe
        segments, info = model.transcribe(
            audio_path,
            language=language,
            beam_size=5,
            vad_filter=True,  # Filter out non-speech
            vad_parameters=dict(min_silence_duration_ms=500)
        )
        
        # Collect all segments
        text_parts = []
        for segment in segments:
            text_parts.append(segment.text.strip())
        
        full_text = " ".join(text_parts).strip()
        
        print(json.dumps({"text": full_text}))
        
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
