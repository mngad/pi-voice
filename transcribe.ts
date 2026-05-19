/**
 * Transcription bridge: calls the Python helper script for Whisper transcription.
 * Also provides raw-PCM-to-WAV conversion for streaming.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";

const execFileAsync = promisify(execFile);

/**
 * Check if a working Python with Whisper is available.
 * Returns true if at least one Python+whisper combo is found.
 */
export async function isWhisperAvailable(): Promise<boolean> {
  try {
    await findPython();
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a working Python that can import whisper or mlx_whisper.
 */
export async function findPython(): Promise<string> {
  const candidates = [
    "python3",
    "python",
  ];

  // On non-Windows, also check common Unix paths
  if (os.platform() !== "win32") {
    candidates.push(
      "/opt/homebrew/bin/python3",
      "/usr/bin/python3",
    );
  }

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
 * Convert raw PCM to a valid WAV file.
 * macOS coreaudio devices record at 48 kHz regardless of requested rate,
 * so we account for that and resample to 16 kHz mono.
 */
export async function rawToWav(rawPath: string, wavPath: string): Promise<void> {
  const actualRate = os.platform() === "darwin" ? "48000" : "16000";
  const soxCmd = os.platform() === "win32" ? "sox" : "sox";

  // Try sox first, then ffmpeg
  const tools = [
    {
      cmd: soxCmd,
      args: ["-r", actualRate, "-e", "signed", "-b", "16", "-c", "1", rawPath, wavPath, "rate", "16000"],
    },
    {
      cmd: "ffmpeg",
      args: ["-f", "s16le", "-ar", actualRate, "-ac", "1", "-i", rawPath, "-ar", "16000", "-y", wavPath],
    },
  ];

  for (const tool of tools) {
    try {
      await execFileAsync(tool.cmd, tool.args, { timeout: 5000, windowsHide: true });
      return;
    } catch {
      continue;
    }
  }

  throw new Error(`Failed to convert raw PCM to WAV. Tried sox and ffmpeg.`);
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
