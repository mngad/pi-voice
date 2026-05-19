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

// SoX uses "rec" on Unix (symlink that makes sox act as recorder).
// On Windows, sox is a single binary — use "sox -d" for default device.
function createSoxRecorder(soxCmd: "rec" | "sox"): Recorder {
  const recordArgs = soxCmd === "rec"
    ? (outputPath: string, duration: number) => [
        "-c", "1", "-b", "16", outputPath,
        "trim", "0", String(duration), "rate", "16000",
      ]
    : (outputPath: string, duration: number) => [
        "-d", "-c", "1", "-b", "16", outputPath,
        "trim", "0", String(duration), "rate", "16000",
      ];

  const continuousArgsFn = soxCmd === "rec"
    ? (outputPath: string) => [
        "-c", "1", "-b", "16", "-e", "signed", "-t", "raw", outputPath,
      ]
    : (outputPath: string) => [
        "-d", "-c", "1", "-b", "16", "-e", "signed", "-t", "raw", outputPath,
      ];

  return {
    name: "sox",
    cmd: soxCmd,
    async record(outputPath, duration) {
      await execFileAsync(soxCmd, recordArgs(outputPath, duration), {
        timeout: (duration + 10) * 1000, windowsHide: true,
      });
    },
    continuousArgs: continuousArgsFn,
  };
}

// ── Windows dshow device detection ────────────────────────────
// ffmpeg on Windows uses dshow; device names vary (e.g.
// "Microphone (USB Microphone)", "Microphone Array (Realtek)").
// We auto-detect the first available audio device.

let cachedWinDevice: string | null = null;

async function detectWindowsAudioDevice(): Promise<string> {
  if (cachedWinDevice) return cachedWinDevice;

  try {
    // Run ffmpeg -list_devices against a dummy input; stderr lists devices.
    // Note: execFile resolves successfully even though "dummy" isn't a valid input file.
    const { stderr } = await execFileAsync("ffmpeg", [
      "-list_devices", "true", "-f", "dshow", "-i", "dummy",
    ], { timeout: 5000, windowsHide: true });

    // Parse lines like: "Microphone (USB Microphone)" (audio)
    const match = stderr.match(/"([^"]+)"\s+\(audio\)/);
    if (match) {
      cachedWinDevice = `audio="${match[1]}"`;
      console.log(`[pi-voice] Detected Windows mic: ${cachedWinDevice}`);
      return cachedWinDevice;
    }
    console.log("[pi-voice] Could not parse dshow devices from stderr, will try fallbacks");
  } catch (err: any) {
    // If execFile itself fails (e.g., ffmpeg not found), check the error stderr too
    const stderr = err?.stderr || "";
    const match = stderr.match(/"([^"]+)"\s+\(audio\)/);
    if (match) {
      cachedWinDevice = `audio="${match[1]}"`;
      console.log(`[pi-voice] Detected Windows mic: ${cachedWinDevice}`);
      return cachedWinDevice;
    }
    console.log("[pi-voice] Could not list dshow devices, will try fallbacks");
  }

  // Fallback: try common patterns in order
  const fallbacks = [
    'audio="Microphone"',
    'audio="Microphone (USB',       // ffmpeg does prefix matching
    'audio="Microphone Array"',
  ];

  for (const device of fallbacks) {
    try {
      await execFileAsync("ffmpeg", [
        "-f", "dshow", "-i", device, "-t", "0.1", "-f", "null", "-",
      ], { timeout: 3000, windowsHide: true });
      cachedWinDevice = device;
      console.log(`[pi-voice] Using Windows mic device: ${device}`);
      return cachedWinDevice;
    } catch {
      continue;
    }
  }

  throw new Error(
    "Could not find a working microphone on Windows.\n" +
    "Run 'ffmpeg -list_devices true -f dshow -i dummy' to see available devices.\n" +
    "Set PI_VOICE_MIC_DEVICE env var to the full device name (e.g. 'audio=\\"My Mic\\"')."
  );
}

function createFfmpegRecorder(inputDevice: string): Recorder {
  const platform = os.platform();
  const inputFormat = platform === "darwin" ? "avfoundation"
    : platform === "win32" ? "dshow" : "alsa";
  const deviceArg = platform === "darwin" ? ":0"
    : platform === "win32" ? inputDevice : "default";

  return {
    name: "ffmpeg",
    cmd: "ffmpeg",
    async record(outputPath, duration) {
      await execFileAsync("ffmpeg", [
        "-f", inputFormat, "-i", deviceArg,
        "-t", String(duration),
        "-ar", "16000", "-ac", "1", "-sample_fmt", "s16",
        "-y", outputPath,
      ], { timeout: (duration + 10) * 1000, windowsHide: true });
    },
    continuousArgs(outputPath) {
      return [
        "-f", inputFormat, "-i", deviceArg,
        "-f", "s16le",           // raw PCM output
        "-ar", "16000", "-ac", "1",
        "-y", outputPath,
      ];
    },
  };
}

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
  // Prefer sox (rec on Unix, sox on Windows)
  if (os.platform() === "win32") {
    if (await isCommandAvailable("sox")) {
      return createSoxRecorder("sox");
    }
  } else {
    if (await isCommandAvailable("rec")) {
      return createSoxRecorder("rec");
    }
  }
  if (await isCommandAvailable("ffmpeg")) {
    // On Windows, auto-detect the dshow audio device
    if (os.platform() === "win32") {
      try {
        const device = await detectWindowsAudioDevice();
        return createFfmpegRecorder(device);
      } catch (err: any) {
        throw new Error(`ffmpeg found but no mic detected: ${err.message}`);
      }
    }
    return createFfmpegRecorder('audio="Microphone"');
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

async function getRecorder(): Promise<Recorder> {
  if (!cachedRecorder) {
    cachedRecorder = await detectRecorder();
    console.log(`[pi-voice] Using recorder: ${cachedRecorder.name}`);
  }
  return cachedRecorder;
}

// ── Public API ────────────────────────────────────────────────────

/** Record audio for a fixed duration. Returns the recorder name used. */
export async function recordAudio(
  outputPath: string,
  duration: number
): Promise<string> {
  const recorder = await getRecorder();
  await recorder.record(outputPath, duration);
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
    const pid = proc.pid;
    if (!pid) {
      resolve();
      return;
    }
    proc.on("exit", () => resolve());

    if (os.platform() === "win32") {
      // Windows: use taskkill for reliable ffmpeg termination
      execFile("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true })
        .on("error", () => {
          // Fallback to Node's built-in kill
          try { proc.kill(); } catch { /* already dead */ }
        });
    } else {
      proc.kill("SIGTERM");
      // Force kill after 2s if still alive
      setTimeout(() => {
        if (proc.exitCode === null) {
          try { proc.kill("SIGKILL"); } catch { /* ok */ }
        }
      }, 2000);
    }
  });
}
