/**
 * EqualizerView — renders vertical mirror-symmetric bars with fBm-driven
 * silhouette, bell-envelope shaping, and perceptual loudness mapping.
 *
 * Bars grow outward from a centerline and are separated by mandatory one-
 * column gaps so adjacent strokes never merge visually. Fractal Brownian
 * motion noise (3 octaves at decreasing spatial scale with decorrelated
 * time drift) produces an organic, non-periodic waveform where nearby bars
 * share a trend. A Hann-derived bell envelope tapers bars toward the edges
 * so they're tallest in the middle.
 *
 * When the theme supplies truecolor, the centre row glows at full accent
 * brightness and outer rows fade through three progressively dimmer steps.
 * Falls back to Pi discrete shade keys for 256/8-color themes.
 */

import type { RecordingStatus } from "../../state/state.js";
import type { StatefulView } from "../stateful-view.js";

// ── Theme keys ──────────────────────────────────────────────────────

const COLOR_ACCENT = "accent";
const COLOR_DIM = "dim";

// ── Gradient ────────────────────────────────────────────────────────

/** Vertical gradient: scale accent RGB by these factors outward from centre.
 *  Applied via theme.fg() so the TUI framework tracks visual width correctly. */
const GRADIENT_BRIGHTNESS = [1.0, 0.65, 0.4, 0.22] as const;
const SHADE_FALLBACK = ["accent", "borderAccent", "muted", "dim"] as const;

// ── Geometry ────────────────────────────────────────────────────────

/** Amplitude counts rings outward from CENTER_ROW. amp=1 lights only the
 *  centreline; amp=MAX_AMP fills the entire column. */
const HALF_SPAN = 3;
const CENTER_ROW = HALF_SPAN;
const ROW_COUNT = HALF_SPAN * 2 + 1;    // 7
const MAX_AMP = HALF_SPAN + 1;          // 4

/** Bars occupy even columns; odd columns are mandatory spacing. */
const BAR_GLYPH = "█";
const SPACE_GLYPH = " ";
const BAR_STRIDE = 2;

// ── Noise ───────────────────────────────────────────────────────────

/** Three octaves of fBm: decreasing spatial scale + decorrelated time drift
 *  give an organic, non-periodic waveform that clusters smoothly. */
const NOISE_OCTAVES = [
	{ spacing: 10, weight: 0.55, drift: 0.04, seed: 13.7 },
	{ spacing: 5,  weight: 0.3,  drift: 0.07, seed: 29.3 },
	{ spacing: 2.5, weight: 0.15, drift: 0.11, seed: 47.1 },
] as const;

/** Fract(sin) shader hash — irrational-looking distribution. */
const HASH_FREQ = 12.9898;
const HASH_AMP = 43758.5453;

/** Mild over-gain so constructive peaks reach MAX_AMP without flattening
 *  every cluster into a mesa. */
const NOISE_PEAK_GAIN = 1.15;

// ── Signal ──────────────────────────────────────────────────────────

/** Perceptual mapping: sqrt(level * PERCEPTUAL_GAIN) saturates around
 *  level≈0.067 so normal speaking volume fills bars without shouting. */
const PERCEPTUAL_GAIN = 15;

/** Single-pole smoother: ~1 s natural decay during silence, fast enough
 *  that onsets punch through. */
const SMOOTHING = 0.3;

// ── Envelope ────────────────────────────────────────────────────────

/**
 * Blended Hann window: 0.5·rc² + 0.5·rc⁵.
 * rc² keeps shoulders broad (smooth taper through every amp bucket);
 * rc⁵ sharpens the centre tip (few slots reach MAX_AMP).
 */
function bellEnvelope(t: number): number {
	const rc = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
	const rc2 = rc * rc;
	const rc5 = rc2 * rc2 * rc;
	return 0.5 * rc2 + 0.5 * rc5;
}

// ── Noise helpers ───────────────────────────────────────────────────

function valueHash(x: number, seed: number): number {
	const v = Math.sin(x * HASH_FREQ + seed) * HASH_AMP;
	return v - Math.floor(v);
}

function valueNoise(x: number, seed: number): number {
	const xi = Math.floor(x);
	const xf = x - xi;
	const u = xf * xf * (3 - 2 * xf); // smoothstep
	const a = valueHash(xi, seed);
	const b = valueHash(xi + 1, seed);
	return a + (b - a) * u;
}

function fbmShape(i: number, phase: number): number {
	let sum = 0;
	for (const o of NOISE_OCTAVES) {
		sum += valueNoise(i / o.spacing + phase * o.drift, o.seed) * o.weight;
	}
	return sum * NOISE_PEAK_GAIN;
}

// ── Quantize & test ─────────────────────────────────────────────────

function quantize(level: number): number {
	const idx = Math.round(level * MAX_AMP);
	return idx < 0 ? 0 : idx > MAX_AMP ? MAX_AMP : idx;
}

function rowLit(amp: number, row: number): boolean {
	if (amp <= 0) return false;
	return Math.abs(row - CENTER_ROW) < amp;
}

// ── Props ───────────────────────────────────────────────────────────

export interface EqualizerViewProps {
	level: number;
	status: RecordingStatus;
	enabled: boolean;
}

// ── View ────────────────────────────────────────────────────────────

export class EqualizerView implements StatefulView<EqualizerViewProps> {
	private props: EqualizerViewProps = { level: 0, status: "recording", enabled: false };
	private envelope = new Float64Array(0);
	private currentBarCount = 0;
	private phase = 0;
	private pendingTicks = 0;
	private smoothedLevel = 0;

	/**
	 * @param theme  Pi Theme object. Used to derive accent-color truecolor
	 *               gradient. If unavailable or non-truecolor, bars render
	 *               uncoloured (falling back to theme.fg("accent", …)).
	 */
	constructor(
		private readonly theme: { fg(color: string, text: string): string },
	) {}

	setProps(props: EqualizerViewProps): void {
		if (props.enabled && props.status === "recording") {
			this.smoothedLevel = (1 - SMOOTHING) * this.smoothedLevel + SMOOTHING * props.level;
			this.pendingTicks += 1;
		}
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.theme) {
			// No theme available — render nothing (shouldn't happen in practice)
			return [];
		}
		const enabled = this.props?.enabled;
		if (enabled === false) return [];
		if (width <= 0) return new Array<string>(ROW_COUNT).fill("");

		const nBars = Math.ceil((width - 2) / BAR_STRIDE);
		if (nBars <= 0) return new Array<string>(ROW_COUNT).fill("");
		if (this.currentBarCount !== nBars) {
			this.envelope = new Float64Array(nBars);
			for (let i = 0; i < nBars; i++) {
				// Shift t slightly inward so edge bars never hit exact 0 or 1,
				// preventing a permanently-blank rightmost column.
				const t = nBars <= 1 ? 0.5 : (i + 0.5) / nBars;
				this.envelope[i] = bellEnvelope(t);
			}
			this.currentBarCount = nBars;
		}

		this.phase += this.pendingTicks;
		this.pendingTicks = 0;

		// smoothedLevel only advances while recording; freezes during pause
		// so bar heights preserve their last snapshot.
		const audioGain = Math.min(1, Math.sqrt(this.smoothedLevel * PERCEPTUAL_GAIN));
		const center = (nBars - 1) / 2;
		const amps = new Uint8Array(nBars);
		for (let i = 0; i < nBars; i++) {
			const shape = fbmShape(Math.abs(i - center), this.phase);
			amps[i] = quantize(shape * this.envelope[i]! * audioGain);
		}

		// Colour only when actively recording.
		const status = this.props?.status;
		const recording = status === "recording";

		const out: string[] = new Array(ROW_COUNT);
		for (let r = 0; r < ROW_COUNT; r++) {
			// 1-char left padding so bars align with the transcript's inset
			let raw = " ";
			for (let c = 0; c < width - 2; c++) {
				if (c % BAR_STRIDE !== 0) {
					raw += SPACE_GLYPH;
					continue;
				}
				raw += rowLit(amps[c / BAR_STRIDE]!, r) ? BAR_GLYPH : SPACE_GLYPH;
			}
			// 1-char right padding for symmetry; slice to exact width
			raw += " ";
			raw = raw.slice(0, width);
			// Apply per-row colour through theme.fg so the TUI framework
			// tracks visual width correctly (raw ANSI codes vary in length).
			if (!recording) {
				out[r] = this.theme.fg(COLOR_DIM, raw);
			} else {
				const dist = Math.abs(r - CENTER_ROW);
				const shadeIdx = Math.min(dist, SHADE_FALLBACK.length - 1);
				out[r] = this.theme.fg(SHADE_FALLBACK[shadeIdx]!, raw);
			}
		}
		return out;
	}
}
