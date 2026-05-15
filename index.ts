/**
 * pi-voice: Voice input extension for pi coding agent
 *
 * Usage:
 *   /voice [duration]  - Record voice for N seconds (default 10), transcribe, and send
 *   Cmd+Shift+V        - Push-to-talk toggle: start/stop recording
 *
 * Requirements:
 *   - Recording: sox (recommended), ffmpeg, or arecord (auto-detected)
 *   - Transcription: Python 3 with whisper (mlx-whisper on macOS, openai-whisper elsewhere)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as fs from "node:fs";
import { recordAudio, startContinuousRecording, stopContinuousRecording } from "./record";
import { transcribeAudio, rawToWav } from "./transcribe";

// ── Paths & defaults ──────────────────────────────────────────────

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const TRANSCRIBE_SCRIPT = join(EXTENSION_DIR, "scripts", "transcribe.py");

const DEFAULT_DURATION = 10;
const MIN_PUSH_TO_TALK_MS = 1500; // ignore recordings shorter than this

const DEFAULT_WHISPER_MODEL = os.platform() === "darwin"
  ? "mlx-community/whisper-large-v3-turbo"
  : "base";

// ── Push-to-talk state ────────────────────────────────────────────

let recordingProc: ChildProcess | null = null;
let recordingRawPath: string | null = null;
let recordingStartedAt: number = 0;

function getTempPath(ext: string): string {
  return join(os.tmpdir(), `pi-voice-${Date.now()}.${ext}`);
}

function clearPushToTalkState() {
  recordingProc = null;
  if (recordingRawPath) {
    try { fs.unlinkSync(recordingRawPath); } catch { /* ok */ }
    recordingRawPath = null;
  }
}

// ── Extension ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── /voice command (fixed-duration) ────────────────────────────
  pi.registerCommand("voice", {
    description: "Record voice, transcribe, and send as input (optionally: /voice <seconds>)",
    handler: async (args, ctx) => {
      const duration = parseInt(args.trim()) || DEFAULT_DURATION;
      if (duration < 1 || duration > 300) {
        ctx.ui.notify("Duration must be between 1 and 300 seconds", "warning");
        return;
      }

      const wavPath = getTempPath("wav");

      try {
        ctx.ui.setStatus("voice", `🎤 Recording (${duration}s)...`);
        ctx.ui.notify(`Recording for ${duration} seconds...`, "info");

        await recordAudio(wavPath, duration);

        ctx.ui.setStatus("voice", "📝 Transcribing...");
        const text = await transcribeAudio(wavPath, TRANSCRIBE_SCRIPT, DEFAULT_WHISPER_MODEL);
        try { fs.unlinkSync(wavPath); } catch { /* ok */ }

        if (!text?.trim()) {
          ctx.ui.notify("No speech detected in recording", "warning");
          ctx.ui.setStatus("voice", "");
          return;
        }

        const preview = text.length > 120 ? text.slice(0, 117) + "..." : text;
        const confirmed = await ctx.ui.confirm("Voice Input", `Send to pi?\n\n"${preview}"`);

        if (confirmed) {
          pi.sendUserMessage(text);
          ctx.ui.notify("Voice input sent", "success");
        }
        if (!confirmed) {
          ctx.ui.notify("Voice input cancelled", "info");
        }
      } catch (err: any) {
        ctx.ui.notify(`Voice error: ${err.message}`, "error");
        try { fs.unlinkSync(wavPath); } catch { /* ok */ }
      } finally {
        ctx.ui.setStatus("voice", "");
      }
    },
  });

  // ── Push-to-talk shortcut (Ctrl+Shift+V) ───────────────────────
  pi.registerShortcut("cmd+shift+v", {
    description: "Push-to-talk voice input (toggle start/stop)",
    handler: async (ctx) => {
      if (recordingProc) {
        // ── STOP recording ───────────────────────────────────

        await stopContinuousRecording(recordingProc);
        recordingProc = null;

        ctx.ui.setStatus("voice", "📝 Transcribing...");

        const elapsed = Date.now() - recordingStartedAt;

        // Too short — discard
        if (elapsed < MIN_PUSH_TO_TALK_MS || !recordingRawPath) {
          ctx.ui.notify("Recording too short, discarded", "warning");
          ctx.ui.setStatus("voice", "");
          clearPushToTalkState();
          return;
        }

        try {
          const wavPath = getTempPath("wav");
          await rawToWav(recordingRawPath!, wavPath);
          const text = await transcribeAudio(wavPath, TRANSCRIBE_SCRIPT, DEFAULT_WHISPER_MODEL);
          try { fs.unlinkSync(wavPath); } catch { /* ok */ }

          clearPushToTalkState();
          ctx.ui.setStatus("voice", "");

          if (!text?.trim()) {
            ctx.ui.notify("No speech detected", "warning");
            return;
          }

          const preview = text.length > 120 ? text.slice(0, 117) + "..." : text;
          const confirmed = await ctx.ui.confirm("Voice Input", `Send to pi?\n\n"${preview}"`);

          if (confirmed) {
            pi.sendUserMessage(text);
            ctx.ui.notify("Voice input sent", "success");
          }
        } catch (err: any) {
          ctx.ui.notify(`Transcription error: ${err.message}`, "error");
          clearPushToTalkState();
          ctx.ui.setStatus("voice", "");
        }
      } else {
        // ── START recording ──────────────────────────────────
        recordingRawPath = getTempPath("raw");
        recordingStartedAt = Date.now();

        try {
          recordingProc = await startContinuousRecording(recordingRawPath);
        } catch (err: any) {
          ctx.ui.notify(`Failed to start recording: ${err.message}`, "error");
          clearPushToTalkState();
          return;
        }

        ctx.ui.setStatus("voice", "🎤 Recording... (Ctrl+Shift+V to stop)");
      }
    },
  });

  // ── Cleanup on session shutdown ─────────────────────────────
  pi.on("session_shutdown", async () => {
    if (recordingProc) {
      try { recordingProc.kill("SIGTERM"); } catch { /* ok */ }
    }
    clearPushToTalkState();
  });

  // ── /voice-model command ────────────────────────────────────
  pi.registerCommand("voice-model", {
    description: "View or set the Whisper model for transcription",
    handler: async (args, ctx) => {
      const model = args.trim();
      if (!model) {
        ctx.ui.notify(`Current Whisper model: ${DEFAULT_WHISPER_MODEL}`, "info");
        return;
      }
      ctx.ui.notify(`Whisper model set to: ${model} (restart required)`, "warning");
    },
  });
}
