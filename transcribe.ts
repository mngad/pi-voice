/**
 * Transcription bridge: calls the Python helper script for Whisper transcription.
 * Also provides raw-PCM-to-WAV conversion for streaming.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";

const execFileAsync = promisify(execFile);

/**
 * Find a working Python that can import whisper or mlx_whisper.
 */
async function findPython(): Promise<string> {
  const candidates = [
    "python3",
    "/Users/fraun/anaconda3/bin/python3",  // conda base
    "/opt/homebrew/bin/python3",           // homebrew
    "/usr/bin/python3",                     // system
    "python",
  ];

  for (const cmd of candidates) {
    try {
      await execFileAsync(cmd, ["-c", "import whisper"], { timeout: 5000, windowsHide: true });
      return cmd;
    } catch {
      try {
        await execFileAsync(cmd, ["-c", "import mlx_whisper"], { timeout: 5000, windowsHide: true });
        return cmd;
      } catch {
        continue;
      }
    }
  }

  throw new Error(
    "No Python with Whisper found. Install:\n" +
    "  pip install openai-whisper\n" +
    "  pip install mlx-whisper  # macOS only"
  );
}

let cachedPython: string | null = null;

async function getPython(): Promise<string> {
  if (!cachedPython) {
    cachedPython = await findPython();
    console.log(`[pi-voice] Using Python: ${cachedPython}`);
  }
  return cachedPython;
}

// ── Raw PCM → WAV conversion ──────────────────────────────────────

/**
 * Convert raw PCM (16kHz, mono, signed 16-bit LE) to a valid WAV file.
 * Used for interim transcription during push-to-talk streaming.
 */
export async function rawToWav(rawPath: string, wavPath: string): Promise<void> {
  // Use sox if available, fall back to ffmpeg
  try {
    await execFileAsync("sox", [
      "-r", "16000",
      "-e", "signed",
      "-b", "16",
      "-c", "1",
      rawPath,
      wavPath,
    ], { timeout: 5000, windowsHide: true });
  } catch {
    // ffmpeg fallback
    await execFileAsync("ffmpeg", [
      "-f", "s16le",
      "-ar", "16000",
      "-ac", "1",
      "-i", rawPath,
      "-y", wavPath,
    ], { timeout: 5000, windowsHide: true });
  }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Transcribe a WAV file using Whisper.
 * Returns the transcription text.
 */
export async function transcribeAudio(
  wavPath: string,
  scriptPath: string,
  model: string
): Promise<string> {
  if (!fs.existsSync(scriptPath)) {
    throw new Error(
      `Transcription script not found: ${scriptPath}\n` +
      `Make sure scripts/transcribe.py exists alongside the extension.`
    );
  }

  if (!fs.existsSync(wavPath)) {
    throw new Error(`Audio file not found: ${wavPath}`);
  }
  if (fs.statSync(wavPath).size < 100) {
    throw new Error("Audio file is too small (likely no audio captured)");
  }

  const python = await getPython();

  const { stdout, stderr } = await execFileAsync(python, [
    scriptPath, wavPath,
    "--model", model,
  ], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });

  if (stderr) {
    console.log(`[pi-voice] whisper stderr: ${stderr.slice(0, 500)}`);
  }

  return stdout.trim();
}
