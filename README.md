# pi-voice 🎤

Voice input extension for [pi](https://github.com/earendil-works/pi-coding-agent) — the terminal coding agent.

Speak instead of type. Your voice is transcribed locally with Whisper and sent to pi as if you typed it.

## Features

- **`/voice`** — record for a fixed duration, transcribe, confirm, and send
- **`Ctrl+Shift+V`** — push-to-talk toggle: press to start recording, press again to stop
- Cross-platform: macOS, Linux, Windows
- Auto-detects recording tools (sox → ffmpeg → arecord)
- Uses mlx-whisper on macOS for speed, openai-whisper everywhere else
- Fully local — no API keys, no cloud, your voice stays on your machine
- Confirmation preview before sending

## Quick Start

### 1. Install dependencies

**Recording** (pick one):
```bash
# Recommended (all platforms)
brew install sox          # macOS
sudo apt install sox      # Linux
choco install sox.portable # Windows
```

**Transcription** (pick one):
```bash
pip install openai-whisper              # Cross-platform
pip install mlx-whisper                 # macOS only (faster, Apple Silicon)
```

### 2. Install the extension

```bash
# From git (recommended)
pi install git:github.com:mngad/pi-voice

# Or project-local for development
mkdir -p .pi/extensions/pi-voice
cp index.ts record.ts transcribe.ts .pi/extensions/pi-voice/
cp -r scripts .pi/extensions/pi-voice/

# Or symlink for development
ln -s $(pwd) .pi/extensions/pi-voice
```

### 3. Use it

```
/voice        Record 10 seconds, transcribe, send
/voice 30     Record 30 seconds
Ctrl+Shift+V   Start recording (push-to-talk), press again to stop
```

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| `/voice [seconds]` | — | Record, transcribe, and send voice input (default: 10s) |
| — | `Ctrl+Shift+V` | Push-to-talk toggle: start/stop recording |
| `/voice-model [name]` | — | View or set the Whisper model |

## How It Works

```
/voice  or  Ctrl+Shift+V
  └─► Records mic audio (sox/ffmpeg/arecord)
  └─► Transcribes with Whisper (local, private)
  └─► Shows preview for confirmation
  └─► Injects as user message into pi
```

## Requirements

- **Recording**: `sox`, `ffmpeg`, or `arecord` (auto-detected)
- **Transcription**: Python 3.8+ with `openai-whisper` and/or `mlx-whisper`
- **pi**: latest version

## Configuration

- `DEFAULT_DURATION` — default recording length in seconds (edit `index.ts`)
- `DEFAULT_WHISPER_MODEL` — default Whisper model (edit `index.ts`)
- `MIN_PUSH_TO_TALK_MS` — minimum recording duration before discarding (edit `index.ts`)
- `/voice-model <name>` — change the Whisper model at runtime (persists across sessions)
