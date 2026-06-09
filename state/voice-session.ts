/**
 * VoiceSession — owns the state machine, view bindings, and effect execution
 * for a voice dictation session.
 *
 * Constructor builds all view components, binds them to state selectors, and
 * wires input routing to state transitions. The imperative shell (command
 * handler) calls `dispatch()` to route keyboard input and `applyEffects()`
 * to execute side effects.
 */

import { loadVoiceConfig, saveVoiceConfig } from "../config/voice-config.js";
import { draftFromConfig } from "../config/config-transforms.js";
import { appendDiagnosticLog } from "../audio/error-log.js";
import { reduce, type ApplyContext, type Effect, type VoiceResult } from "./state-reducer.js";
import { type VoiceAction, routeKey } from "./key-router.js";
import { initialVoiceState, type VoiceState } from "./state.js";
import {
	selectEqualizerProps,
	selectSettingsFormProps,
	selectStatusBarProps,
	selectTranscriptProps,
} from "./selectors/projections.js";
import { binding } from "../view/component-binding.js";
import { EqualizerView } from "../view/components/equalizer-view.js";
import { SettingsFormView } from "../view/components/settings-form-view.js";
import { StatusBarView } from "../view/components/status-bar-view.js";
import { TranscriptView } from "../view/components/transcript-view.js";
import { VoiceOverlayPropsAdapter } from "../view/props-adapter.js";
import { OverlayView } from "../view/overlay-view.js";
import {
	createDictationStrategy,
	createSettingsStrategy,
} from "../view/screen-content-strategy.js";

export interface VoiceSessionDeps {
	pasteToEditor: (text: string) => void;
	notify: (message: string, level: "error" | "info" | "warning") => void;
	abort: () => void;
	stopRecording: () => void;
}

export interface VoiceSessionInput {
	tui: { terminal: { rows?: number; columns: number }; requestRender(): void };
	theme?: { fg(color: string, text: string): string };
	deps: VoiceSessionDeps;
	done: (result: VoiceResult) => void;
}

const PULSE_INTERVAL_MS = 160;
const TIMER_INTERVAL_MS = 1000;

export class VoiceSession {
	readonly component: OverlayView;
	private state: VoiceState;
	private adapter: VoiceOverlayPropsAdapter;
	private readonly tui: VoiceSessionInput["tui"];
	private readonly deps: VoiceSessionDeps;
	private config: ApplyContext;
	private pulseTimer: ReturnType<typeof setInterval> | null = null;
	private secondsTimer: ReturnType<typeof setInterval> | null = null;

	constructor(input: VoiceSessionInput) {
		this.tui = input.tui;
		this.deps = input.deps;
		this.doneCallback = input.done;

		const persistedConfig = loadVoiceConfig();
		this.config = { persistedConfig };
		this.state = initialVoiceState(draftFromConfig(persistedConfig));

		// Build view components
		const transcriptView = new TranscriptView();
		const equalizerView = new EqualizerView(input.theme ?? { fg: (_c, t) => t });
		const statusBarView = new StatusBarView();
		const settingsFormView = new SettingsFormView();

		// Bind components to selectors
		const bindings = [
			binding(selectTranscriptProps, transcriptView),
			binding(selectEqualizerProps, equalizerView),
			binding(selectStatusBarProps, statusBarView),
			binding(selectSettingsFormProps, settingsFormView),
		] as const;

		// Create strategies for the overlay
		const dictStrategy = createDictationStrategy(bindings[0], bindings[1], bindings[2]);
		const settStrategy = createSettingsStrategy(bindings[3], bindings[2]);

		// Props adapter pushes state to components
		this.adapter = new VoiceOverlayPropsAdapter({ tui: this.tui, bindings });

		// Main overlay view — wire its handleInput directly to this session
		this.component = new OverlayView(dictStrategy, settStrategy);
		if (input.theme) {
			this.component.setTheme({ fg: input.theme.fg.bind(input.theme) });
		}
		this.component.setState(this.state);
		this.component.onInput = (data: string) => {
			const vr = this.handleInput(data);
			appendDiagnosticLog("session", "handleInput result:" + (vr ? JSON.stringify(vr) : "null"));
			if (vr) {
				appendDiagnosticLog("session", "calling doneCallback");
				setTimeout(() => this.doneCallback(vr), 0);
			} else {
				this.tui.requestRender();
			}
		};

		// Push initial state to all components
		this.adapter.apply(this.state);
	}

	private readonly doneCallback: (result: VoiceResult) => void;

	/**
	 * Start the recording session: begin pulse animation + timer.
	 */
	startRecording(): void {
		this.dispatch({ kind: "set_status", status: "recording" });
		this.startTimers();
	}

	/**
	 * Called when transcription completes with the final text.
	 */
	setTranscript(text: string): void {
		appendDiagnosticLog("session", "setTranscript called with text length:" + text.length + " preview:" + text.slice(0, 60));
		this.dispatch({ kind: "set_transcript", text });
		appendDiagnosticLog("session", "setTranscript after dispatch, state.transcript:" + this.state.transcript.slice(0, 60));
	}

	/**
	 * Set audio level for equalizer (0-1). Called periodically during recording.
	 */
	setAudioLevel(level: number): void {
		this.dispatch({ kind: "set_audio_level", level });
	}

	/**
	 * Stop all timers and clean up.
	 */
	stop(): void {
		if (this.pulseTimer) {
			clearInterval(this.pulseTimer);
			this.pulseTimer = null;
		}
		if (this.secondsTimer) {
			clearInterval(this.secondsTimer);
			this.secondsTimer = null;
		}
	}

	/**
	 * Route keyboard input through the state machine.
	 * Returns the VoiceResult if the session terminated, null otherwise.
	 */
	dispatch(action: VoiceAction): VoiceResult | null {
		const result = reduce(this.state, action, this.config);
		this.state = result.state;
		this.component.setState(this.state);

		// Execute effects
		for (const effect of result.effects) {
			const done = this.runEffect(effect);
			if (done) return done;
		}

		// Push state to all bound components
		this.adapter.apply(this.state);
		return null;
	}

	/**
	 * Handle raw keyboard data from the TUI.
	 */
	handleInput(data: string): VoiceResult | null {
		const action = routeKey(data, this.state.currentScreen, this.state.status, this.state.transcript);
		if (!action) return null;
		return this.dispatch(action);
	}

	/**
	 * Pulse tick (called by external interval).
	 */
	tickPulse(): void {
		this.dispatch({ kind: "tick_pulse" });
	}

	private startTimers(): void {
		this.pulseTimer = setInterval(() => this.tickPulse(), PULSE_INTERVAL_MS);
		this.secondsTimer = setInterval(() => this.dispatch({ kind: "tick_timer" }), TIMER_INTERVAL_MS);
	}

	private runEffect(effect: Effect): VoiceResult | null {
		switch (effect.kind) {
			case "request_render":
				break; // handled by adapter
			case "paste_to_editor":
				this.deps.pasteToEditor(effect.text);
				break;
			case "notify":
				this.deps.notify(effect.message, effect.level);
				break;
			case "abort_session":
				this.deps.abort();
				break;
			case "stop_recording":
				this.deps.stopRecording();
				break;
			case "set_pipeline_paused":
				// v1: no-op. v2: control the recording pipeline.
				break;
			case "set_hallucination_filter":
				// v1: stored in state, applied post-transcription. No pipeline action needed.
				break;
			case "start_transcription":
				break; // handled externally by command handler
			case "save_config": {
				const ok = saveVoiceConfig(effect.config);
				if (!ok) {
					this.deps.notify("Failed to save voice config", "error");
				} else if (effect.successMessage) {
					this.deps.notify(effect.successMessage, "info");
				}
				break;
			}
			case "done":
				this.stop();
				return effect.result;
		}
		return null;
	}
}
