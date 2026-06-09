/**
 * OverlayView — top-level TUI view for the voice overlay.
 *
 * Renders the active screen (dictation or settings) by delegating to its
 * strategy, pads to maintain consistent chrome height across screen flips,
 * and adds a border with theme-colored box-drawing characters.
 *
 * Implements `handleInput` directly so the TUI routes keys through this
 * component without a wrapper proxy. Delegates to an external handler set
 * by the session.
 */

import { Container } from "@earendil-works/pi-tui";
import { appendDiagnosticLog } from "../audio/error-log.js";
import type { VoiceState } from "../state/state.js";
import type { ScreenComponent } from "./screen-content-strategy.js";

export interface OverlayViewTheme {
	fg(color: string, text: string): string;
}

export type OverlayInputHandler = (data: string) => void;

export interface OverlayViewProps {
	state: VoiceState;
}

// Number of fixed chrome rows at the bottom (equalizer 7 + status bar 1 = 8).
// Border adds 2 rows (top + bottom), 2 columns (left + right).
const CHROME_ROWS_WITH_EQ = 8;
const CHROME_ROWS_WITHOUT_EQ = 1;

// Unicode box-drawing characters for a single-line border.
const BORDER = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
};

export class OverlayView {
	private liveState: VoiceState | undefined;
	private dictationStrategy: (state: VoiceState) => ScreenComponent[];
	private settingsStrategy: (state: VoiceState) => ScreenComponent[];
	private targetBodyHeight = 0;
	private theme: OverlayViewTheme | undefined;
	/** External input handler set by the session after construction. */
	public onInput: OverlayInputHandler | null = null;

	constructor(
		dictationStrategy: (state: VoiceState) => ScreenComponent[],
		settingsStrategy: (state: VoiceState) => ScreenComponent[],
	) {
		this.dictationStrategy = dictationStrategy;
		this.settingsStrategy = settingsStrategy;
	}

	setState(state: VoiceState): void {
		this.liveState = state;
	}

	/** Set the theme for border coloring. Called once before render. */
	setTheme(theme: OverlayViewTheme): void {
		this.theme = theme;
	}

	render(width: number): string[] {
		const state = this.liveState;
		if (!state) return [];

		const innerWidth = Math.max(20, width - 2);
		const isSettings = state.currentScreen === "settings";
		const strategy = isSettings ? this.settingsStrategy : this.dictationStrategy;
		const chromeRows = state.settingsDraft.equalizerEnabled ? CHROME_ROWS_WITH_EQ : CHROME_ROWS_WITHOUT_EQ;

		const children = strategy(state);
		const allRows = flattenChildren(children, innerWidth);
		const bodyRows = Math.max(0, allRows.length - chromeRows);
		this.targetBodyHeight = Math.max(this.targetBodyHeight, bodyRows);

		const padNeeded = this.targetBodyHeight - bodyRows;
		const padded = padNeeded > 0 ? [...new Array<string>(padNeeded).fill(""), ...allRows] : allRows;

		// Apply border around the padded content
		const framed = this.applyBorder(padded, innerWidth);
		return framed;
	}

	invalidate(): void {}

	/**
	 * Handle keyboard input. Delegates to the external onInput handler.
	 */
	handleInput(data: string): void {
		appendDiagnosticLog("overlay", "handleInput data:" + JSON.stringify(data) + " onInput:" + String(!!this.onInput));
		if (this.onInput) {
			this.onInput(data);
		}
	}

	private applyBorder(lines: string[], innerWidth: number): string[] {
		if (lines.length === 0) return [];

		const c = (char: string) => this.style(char);
		const topLine = c(BORDER.topLeft) + c(BORDER.horizontal).repeat(innerWidth) + c(BORDER.topRight);
		const bottomLine = c(BORDER.bottomLeft) + c(BORDER.horizontal).repeat(innerWidth) + c(BORDER.bottomRight);

		const bordered = lines.map((line) => {
			// Measure visible width by stripping ANSI escape sequences.
			// Raw line.length includes invisible control chars from theme.fg(),
			// which would cause misaligned borders if used directly.
			const visibleLen = ansiVisibleLength(line);
			if (visibleLen < innerWidth) {
				// Pad with spaces. Append after any trailing ANSI reset codes
				// so the padding inherits the line's active SGR state.
				const suffix = extractAnsiSuffix(line);
				const plain = line.slice(0, line.length - suffix.length);
				const padded = plain + " ".repeat(innerWidth - visibleLen) + suffix;
				return c(BORDER.vertical) + padded + c(BORDER.vertical);
			}
			// Visible width >= innerWidth: trust the component.
			return c(BORDER.vertical) + line + c(BORDER.vertical);
		});

		return [topLine, ...bordered, bottomLine];
	}

	private style(char: string): string {
		if (this.theme) {
			return this.theme.fg("accent", char);
		}
		return char;
	}
}

function flattenChildren(children: ScreenComponent[], width: number): string[] {
	const container = new Container();
	for (const child of children) {
		if ("addChild" in (child as unknown as Record<string, unknown>)) {
			container.addChild(child as unknown as { render(w: number): string[]; invalidate(): void });
		} else {
			const wrapper = {
				render: (w: number) => (child as ScreenComponent).render(w),
				invalidate: () => {},
			};
			container.addChild(wrapper);
		}
	}
	return container.render(width);
}

// ── ANSI-aware width helpers ───────────────────────────────────────

/** Count visible characters in a string by stripping ANSI escape sequences. */
function ansiVisibleLength(s: string): number {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").length;
}

/** Extract trailing ANSI escape sequences (SGR resets etc.) from a string. */
function extractAnsiSuffix(s: string): string {
	const match = s.match(/((?:\x1b\[[0-9;]*[a-zA-Z])+)$/);
	return match ? match[1] : "";
}
