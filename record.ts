/**
 * Cross-platform audio recording via shell commands.
 *
 * Auto-detects available recording tools in this order:
 *   1. sox (rec)      - recommended, cross-platform
 *   2. ffmpeg          - cross-platform, different device flags per OS
 *   3. arecord         - Linux ALSA
 *
 * Supports both:
 *   - Fixed-duration recording (recordAudio)
 *   - Continuous push-to-talk recording (start/stopContinuousRecording)
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import { renameSync, unlinkSync } from "node:fs";

const execFileAsync = promisify(execFile);

interface Recorder {
  name: string;
  record: (outputPath: string, duration: number) => Promise<void>;
  /** Command name for spawning continuous recording */
  cmd: string;
  /** Args for continuous recording (raw PCM to stdout/file) */
  continuousArgs: (outputPath: string) => string[];
}

// ── Recorder implementations ──────────────────────────────────────

const soxRecorder: Recorder = {
  name: "sox",
  cmd: "rec",
  async record(outputPath, duration) {
    await execFileAsync("rec", [
      "-r", "16000",
      "-c", "1",
      "-b", "16",
      outputPath,
      "trim", "0", String(duration),
    ], { timeout: (duration + 10) * 1000, windowsHide: true });
  },
  continuousArgs(outputPath) {
    return [
      "-r", "16000",
      "-c", "1",
      "-b", "16",
      "-e", "signed",
      "-t", "raw",   // raw PCM — no header, easy to snapshot
      outputPath,
    ];
  },
};

const ffmpegRecorder: Recorder = {
  name: "ffmpeg",
  cmd: "ffmpeg",
  async record(outputPath, duration) {
    const platform = os.platform();
    const inputFormat = platform === "darwin" ? "avfoundation"
      : platform === "win32" ? "dshow" : "alsa";
    const inputDevice = platform === "darwin" ? ":0"
      : platform === "win32" ? 'audio="Microphone"' : "default";

    await execFileAsync("ffmpeg", [
      "-f", inputFormat, "-i", inputDevice,
      "-t", String(duration),
      "-ar", "16000", "-ac", "1", "-sample_fmt", "s16",
      "-y", outputPath,
    ], { timeout: (duration + 10) * 1000, windowsHide: true });
  },
  continuousArgs(outputPath) {
    const platform = os.platform();
    const inputFormat = platform === "darwin" ? "avfoundation"
      : platform === "win32" ? "dshow" : "alsa";
    const inputDevice = platform === "darwin" ? ":0"
      : platform === "win32" ? 'audio="Microphone"' : "default";

    return [
      "-f", inputFormat, "-i", inputDevice,
      "-f", "s16le",           // raw PCM output
      "-ar", "16000", "-ac", "1",
      "-y", outputPath,
    ];
  },
};

const arecordRecorder: Recorder = {
  name: "arecord",
  cmd: "arecord",
  async record(outputPath, duration) {
    await execFileAsync("arecord", [
      "-f", "S16_LE", "-r", "16000", "-c", "1",
      "-d", String(duration), outputPath,
    ], { timeout: (duration + 10) * 1000 });
  },
  continuousArgs(outputPath) {
    return [
      "-f", "S16_LE", "-r", "16000", "-c", "1",
      outputPath,
    ];
  },
};

// ── Tool availability checks ──────────────────────────────────────

async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    const checkCmd = os.platform() === "win32" ? "where" : "which";
    await execFileAsync(checkCmd, [cmd], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ── Auto-detect the best recorder ─────────────────────────────────

export async function detectRecorder(): Promise<Recorder> {
  if (await isCommandAvailable("rec")) {
    return soxRecorder;
  }
  if (await isCommandAvailable("ffmpeg")) {
    return ffmpegRecorder;
  }
  if (os.platform() === "linux" && (await isCommandAvailable("arecord"))) {
    return arecordRecorder;
  }

  throw new Error(
    "No audio recorder found. Please install one of: sox, ffmpeg, or arecord.\n" +
    "  macOS:  brew install sox\n" +
    "  Linux:  sudo apt install sox\n" +
    "  Windows: choco install sox.portable"
  );
}

let cachedRecorder: Recorder | null = null;
let cachedSoxAvailable: boolean | null = null;

async function getRecorder(): Promise<Recorder> {
  if (!cachedRecorder) {
    cachedRecorder = await detectRecorder();
    console.log(`[pi-voice] Using recorder: ${cachedRecorder.name}`);
  }
  return cachedRecorder;
}

/** Strip leading and trailing silence from a WAV file using sox. */
export async function trimSilence(wavPath: string): Promise<void> {
  if (cachedSoxAvailable === null) {
    cachedSoxAvailable = await isCommandAvailable("sox");
  }
  if (!cachedSoxAvailable) return;

  const tmp = wavPath + ".trimmed.wav";
  try {
    await execFileAsync("sox", [
      wavPath, tmp,
      "silence", "1", "0.1", "1%", "-1", "0.1", "1%",
    ], { timeout: 10_000, windowsHide: true });

    renameSync(tmp, wavPath);
  } catch {
    try { unlinkSync(tmp); } catch { /* ok */ }
  }
}

// ── Public API ────────────────────────────────────────────────────

/** Record audio for a fixed duration. Returns the recorder name used. */
export async function recordAudio(
  outputPath: string,
  duration: number
): Promise<string> {
  const recorder = await getRecorder();
  await recorder.record(outputPath, duration);

  // Strip leading/trailing silence if sox is available
  if (recorder.name === "sox") {
    await trimSilence(outputPath);
  }

  return recorder.name;
}

/**
 * Start continuous recording (push-to-talk).
 * Writes raw PCM to `outputPath`. Returns the child process.
 */
export async function startContinuousRecording(
  outputPath: string
): Promise<ChildProcess> {
  const recorder = await getRecorder();
  const args = recorder.continuousArgs(outputPath);
  const proc = spawn(recorder.cmd, args, { stdio: "ignore" });
  return proc;
}

/** Stop a continuous recording process. */
export function stopContinuousRecording(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.on("exit", () => resolve());
    proc.kill("SIGTERM");
    // Force kill after 2s if still alive
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, 2000);
  });
}
