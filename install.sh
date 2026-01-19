#!/bin/bash
set -e

echo "=== Installing system dependencies ==="

# Install ffmpeg (required for audio conversion)
if command -v ffmpeg &> /dev/null; then
    echo "✓ ffmpeg already installed"
else
    echo "Installing ffmpeg..."
    if command -v apt-get &> /dev/null; then
        sudo apt-get update -qq
        sudo apt-get install -y -qq ffmpeg
    elif command -v yum &> /dev/null; then
        sudo yum install -y ffmpeg
    elif command -v apk &> /dev/null; then
        apk add --no-cache ffmpeg
    elif command -v pacman &> /dev/null; then
        sudo pacman -S --noconfirm ffmpeg
    else
        echo "⚠ Could not install ffmpeg automatically. Please install it manually."
    fi
fi

# Install Python3 and pip if not present
if ! command -v python3 &> /dev/null; then
    echo "Installing python3..."
    if command -v apt-get &> /dev/null; then
        sudo apt-get install -y -qq python3 python3-pip
    elif command -v yum &> /dev/null; then
        sudo yum install -y python3 python3-pip
    elif command -v apk &> /dev/null; then
        apk add --no-cache python3 py3-pip
    fi
else
    echo "✓ python3 already installed"
fi

echo "=== Installing Python dependencies (faster-whisper) ==="

# Install faster-whisper
if command -v pip3 &> /dev/null; then
    pip3 install --user faster-whisper || pip3 install faster-whisper
elif command -v pip &> /dev/null; then
    pip install --user faster-whisper || pip install faster-whisper
else
    python3 -m pip install --user faster-whisper || python3 -m pip install faster-whisper
fi

echo "=== Installation complete ==="
echo "Run 'npm start' to start the server"
