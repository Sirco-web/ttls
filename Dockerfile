# Voice-Text Room with Server-Side Whisper STT
FROM node:20-slim

# Install system dependencies: ffmpeg, python3, pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install faster-whisper (Python STT library)
RUN pip3 install --break-system-packages faster-whisper

WORKDIR /app

# Copy package files and install Node dependencies
COPY package.json package-lock.json ./
RUN npm install --omit=dev --ignore-scripts

# Copy application code
COPY . .

# Runtime configuration
ENV PORT=3000
ENV HOST=0.0.0.0
ENV USE_PYTHON_STT=1

EXPOSE 3000

CMD ["node", "server.js"]
