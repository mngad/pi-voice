/**
 * voice-command — /voice command handler + F5 push-to-talk handler.
 *
 * Workflow:
 *   Speak → Enter (stop recording) → Review → Enter (send) or Esc (discard)
 *
 * /voice starts recording immediately. F5 toggles start/stop manually.
 * Both use Enter to finish speaking and move to the review phase.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { startContinuousRecording, stopContinuousRecording, detectRecorder } from "../audio/record.js";
import { transcribeAudio, rawToWav, isWhisperAvailable } from "../audio/transcribe.js";
import { filterHallucinations } from "../audio/hallucination-filter.js";
import { appendDiagnosticLog } from "../audio/error-log.js";
import { isHallucinationFilterEnabled, loadVoiceConfig } from "../config/voice-config.js";
import type { VoiceResult } from "../state/state-reducer.js";
import { VoiceSession } from "../state/voice-session.js";

// ── Paths & defaults ─────────────────────────────────────────────────────────

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

function getTranscribeScript(): string {
	const audioPath = join(EXTENSION_DIR, "..", "audio", "transcribe.py");
	if (fs.existsSync(audioPath)) return audioPath;
	return join(EXTENSION_DIR, "..", "scripts", "transcribe.py");
}

const DEFAULT_WHISPER_MODEL = os.platform() === "darwin"
	? "mlx-community/whisper-large-v3-turbo"
	: "base";

let currentModel = DEFAULT_WHISPER_MODEL;

// ── Shared push-to-talk state ────────────────────────────────────────────────

let recordingProc: ChildProcess | null = null;
let recordingRawPath: string | null = null;

// ── Equalizer tick ───────────────────────────────────────────────────────────

const EQ_INTERVAL_MS = 50;

function getTempPath(ext: string): string {
	return join(os.tmpdir(), `pi-voice-${Date.now()}.${ext}`);
}

function clearRecordingState() {
	recordingProc = null;
	if (recordingRawPath) {
		try { fs.unlinkSync(recordingRawPath); } catch { /* ok */ }
		recordingRawPath = null;
	}
}

type NotifyLevel = "error" | "info" | "warning";

// ── Extension registration ───────────────────────────────────────────────────

export function registerVoiceCommand(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "pi-voice-model") {
				const data = entry.data as Record<string, unknown> | undefined;
				if (data?.model && typeof data.model === "string") {
					currentModel = data.model;
				}
			}
		}
		if (event.reason !== "startup") return;

		let issues: string[] = [];
		try { await detectRecorder(); } catch (err: unknown) {
			issues.push(`No recorder: ${err instanceof Error ? err.message : String(err)}`);
		}
		try {
			if (!(await isWhisperAvailable())) issues.push("Whisper not found. Install: pip install openai-whisper");
		} catch (err: unknown) {
			issues.push(`Whisper check failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (issues.length > 0) ctx.ui.notify(`pi-voice: ${issues.join(" | ")}`, "warning");
	});

	pi.registerCommand("voice", {
		description: "Speak, press Enter to transcribe and review, Enter again to send",
		handler: async (_args, ctx) => {
			if (recordingProc) {
				ctx.ui.notify("Already recording. Press F5 to stop, or Enter in the overlay.", "warning");
				return;
			}
			await runRecordingSession(ctx, "voice");
		},
	});

	pi.registerShortcut("f5", {
		description: "Push-to-talk voice input (toggle)",
		handler: async (ctx: ExtensionContext) => {
			if (recordingProc) {
				await finishAndTranscribe(ctx);
			} else {
				await runRecordingSession(ctx, "f5");
			}
		},
	});

	pi.on("session_shutdown", async () => {
		if (recordingProc) {
			try { recordingProc.kill("SIGTERM"); } catch { /* ok */ }
		}
		clearRecordingState();
	});

	pi.registerCommand("voice-model", {
		description: "View or set the Whisper model for transcription",
		handler: async (args, ctx) => {
			const model = args.trim();
			if (!model) { ctx.ui.notify(`Current Whisper model: ${currentModel}`, "info"); return; }
			currentModel = model;
			pi.appendEntry("pi-voice-model", { model });
			ctx.ui.notify(`Whisper model set to: ${model}`, "info");
		},
	});
}

// ── Shared recording session ─────────────────────────────────────────────────

/**
 * Start continuous recording, show the overlay, and handle the full
 * speak → review → send lifecycle. Used by both /voice and F5.
 */
async function runRecordingSession(
	ctx: ExtensionContext | ExtensionCommandContext,
	source: "voice" | "f5",
): Promise<void> {
	recordingRawPath = getTempPath("raw");

	try {
		recordingProc = await startContinuousRecording(recordingRawPath);
	} catch (err: unknown) {
		ctx.ui.notify(`Failed to start recording: ${err instanceof Error ? err.message : String(err)}`, "error");
		clearRecordingState();
		return;
	}

	let transcriptionPromise: Promise<string | null> | null = null;

	const result = await ctx.ui.custom<VoiceResult>((tui, theme, _kb, done) => {
		const session = new VoiceSession({
			tui,
			theme,
			deps: {
				pasteToEditor: (text) => ctx.ui.pasteToEditor(text),
				notify: (msg, level) => ctx.ui.notify(msg, level),
				abort: () => done({ intent: "cancel", transcript: "" }),
				stopRecording: () => {
					// Trigger transcription when the user presses Enter during recording
					if (recordingProc && recordingRawPath) {
						appendDiagnosticLog("cmd", "stopRecording triggered, starting transcription");
						transcriptionPromise = runTranscription(recordingRawPath);
					}
				},
			},
			done,
		});

		if (source === "voice") {
			// /voice auto-starts recording
			session.startRecording();
		} else {
			// F5: user pressed it to start, so we're already recording
			// The recording was started before this overlay. Just set state.
			session.startRecording();
		}

		// Equalizer animation
		let eqTick: ReturnType<typeof setInterval> | undefined;
		let elapsed = 0;
		eqTick = setInterval(() => {
			if (!recordingProc && !transcriptionPromise) {
				if (eqTick) clearInterval(eqTick);
				return;
			}
			elapsed += EQ_INTERVAL_MS / 1000;
			const level = 0.3 + 0.4 * Math.sin(elapsed * 3) * Math.cos(elapsed * 1.7) + 0.2 * Math.random();
			session.setAudioLevel(Math.max(0, Math.min(1, level)));
		}, EQ_INTERVAL_MS);

		// The overlay's onInput is set by VoiceSession to call session.handleInput().
		// We augment it to also handle transcription completion.
		const origOnInput = session.component.onInput;
		session.component.onInput = (data: string) => {
			origOnInput?.(data);
			// After the user has committed (Enter in review) or cancelled,
			// done() will be called and the overlay will close.
			// Meanwhile, check if transcription completed.
			void checkTranscription(session, transcriptionPromise, eqTick, done, ctx);
		};

		return session.component;
	}, { overlay: true, overlayOptions: { anchor: "center", maxHeight: "60%", minWidth: 40, width: "50%" } });

	// After overlay closes, handle the result
	if (result.intent === "commit" && result.transcript) {
		appendDiagnosticLog("cmd", "pasting to editor:" + result.transcript.slice(0, 80));
		ctx.ui.pasteToEditor(result.transcript);
	}
}

async function finishAndTranscribe(ctx: ExtensionContext): Promise<void> {
	// F5 pressed while recording — stop and transcribe
	if (!recordingProc || !recordingRawPath) return;
	stopContinuousRecording(recordingProc).catch(() => {});
	recordingProc = null;

	const text = await runTranscription(recordingRawPath);
	if (text) {
		await showReviewOverlay(ctx, text);
	}
}

async function showReviewOverlay(ctx: ExtensionContext, text: string): Promise<void> {
	const result = await ctx.ui.custom<VoiceResult>((tui, theme, _kb, done) => {
		const session = new VoiceSession({
			tui,
			theme,
			deps: {
				pasteToEditor: (t) => ctx.ui.pasteToEditor(t),
				notify: (msg, level) => ctx.ui.notify(msg, level),
				abort: () => done({ intent: "cancel", transcript: "" }),
				stopRecording: () => {},
			},
			done,
		});
		session.dispatch({ kind: "set_transcript", text });

		return session.component;
	}, { overlay: true, overlayOptions: { anchor: "center", maxHeight: "60%", minWidth: 40, width: "50%" } });

	if (result.intent === "commit" && result.transcript) {
		ctx.ui.pasteToEditor(result.transcript);
	}
}

async function runTranscription(rawPath: string): Promise<string | null> {
	if (!recordingProc) {
		appendDiagnosticLog("cmd", "runTranscription: recordingProc is null");
		return null;
	}

	// Stop the mic process
	await stopContinuousRecording(recordingProc);
	recordingProc = null;

	const raw = rawPath;

	// Check if the raw file has data
	try {
		const stat = fs.statSync(raw);
		appendDiagnosticLog("cmd", "raw file size:" + stat.size + " bytes");
		if (stat.size < 100) {
			appendDiagnosticLog("cmd", `raw file too small (${stat.size} bytes), likely no audio captured`);
			clearRecordingState();
			return null;
		}
	} catch {
		appendDiagnosticLog("cmd", "raw file not found:" + raw);
		clearRecordingState();
		return null;
	}

	const wavPath = getTempPath("wav");

	try {
		appendDiagnosticLog("cmd", "converting raw to wav...");
		await rawToWav(raw, wavPath);
		appendDiagnosticLog("cmd", "wav created, size:" + fs.statSync(wavPath).size + " bytes");
		// Only clean up raw file after successful WAV conversion
		clearRecordingState();
	} catch (err: unknown) {
		appendDiagnosticLog("cmd", "rawToWav failed:" + (err instanceof Error ? err.message : String(err)));
		try { fs.unlinkSync(wavPath); } catch { /* ok */ }
		clearRecordingState();
		return null;
	}

	try {
		appendDiagnosticLog("cmd", "transcribing...");
		let text = await transcribeAudio(wavPath, getTranscribeScript(), currentModel);
		try { fs.unlinkSync(wavPath); } catch { /* ok */ }

		appendDiagnosticLog("cmd", "raw transcription:" + (text || "(empty)").slice(0, 80));

		if (!text?.trim()) {
			appendDiagnosticLog("cmd", "transcription returned empty/null — no speech detected");
			return null;
		}

		const config = loadVoiceConfig();
		if (isHallucinationFilterEnabled(config)) {
			text = filterHallucinations(text);
		}

		appendDiagnosticLog("cmd", "transcription result:" + text.slice(0, 80));
		return text.trim() || null;
	} catch (err: unknown) {
		appendDiagnosticLog("cmd", "transcription error:" + (err instanceof Error ? err.message : String(err)));
		try { fs.unlinkSync(wavPath); } catch { /* ok */ }
		return null;
	}
}

/**
 * Poll for transcription completion after the user pressed Enter during recording.
 * When transcription finishes, update the overlay with the result.
 */
async function checkTranscription(
	session: VoiceSession,
	promise: Promise<string | null> | null,
	eqTick: ReturnType<typeof setInterval> | undefined,
	done: (result: VoiceResult) => void,
	ctx: ExtensionContext | ExtensionCommandContext,
): Promise<void> {
	if (!promise) return;

	try {
		const text = await promise;
		if (eqTick) clearInterval(eqTick);

		if (!text) {
			ctx.ui.notify("No speech detected", "warning");
			done({ intent: "cancel", transcript: "" });
			return;
		}

		appendDiagnosticLog("cmd", "calling session.setTranscript, text:" + text.slice(0, 60));
		session.setTranscript(text);
	} catch (err: unknown) {
		if (eqTick) clearInterval(eqTick);
		ctx.ui.notify(`Transcription error: ${err instanceof Error ? err.message : String(err)}`, "error");
		done({ intent: "cancel", transcript: "" });
	}
}
