/**
 * pi-voice web plugin
 *
 * Browser-side voice input for pi-web. Captures microphone audio in the
 * browser (works locally AND remotely), writes it to a workspace temp file,
 * runs the bundled Whisper transcription script on the server via the
 * workspace terminal helper, reads the transcript back, and inserts it
 * into the chat prompt.
 *
 * Surface:
 *   - A "Voice" workspace panel with a push-to-talk mic button, a live
 *     recording timer, a Whisper model field, and a transcript/error preview.
 *   - A "Voice input" action with the `mod+shift+v` shortcut that toggles
 *     recording (uses the workspace context captured by the panel).
 *
 * Requirements (on the machine running the pi daemon / pi-web server):
 *   - python3 with openai-whisper (pip install openai-whisper) or mlx-whisper on macOS
 *   - ffmpeg (required by whisper for audio decoding)
 *   - HTTPS or localhost for microphone access (browser security requirement)
 *
 * Notes:
 *   - Audio is captured in the browser, so this works when accessing pi-web
 *     remotely — the server's microphone is never used.
 *   - Transcription runs on the server with your local Whisper models, so no
 *     audio leaves your machine and quality matches the TUI pi-voice extension.
 *   - Temp files are written under `.pi-voice/` in the workspace and cleaned up
 *     after each transcription. The transcription script is written once and
 *     reused.
 */

// Whisper transcription script, written into the workspace on first use so the
// server shell can execute it. Kept in sync with the TUI pi-voice package.
const TRANSCRIBE_PY = String.raw`#!/usr/bin/env python3
"""Whisper transcription helper for pi-voice web plugin."""
import argparse
import platform
import sys


def transcribe_mlx(audio_path, model):
    import mlx_whisper
    result = mlx_whisper.transcribe(audio_path, path_or_hf_repo=model, language="en")
    return result["text"].strip()


def transcribe_openai(audio_path, model):
    import whisper
    import torch
    size_map = {
        "tiny": "tiny.en", "base": "base.en", "small": "small.en",
        "medium": "medium.en", "large": "large", "large-v3": "large-v3",
        "large-v3-turbo": "large-v3-turbo",
    }
    if "/" in model:
        size = "base.en"
        for key in size_map:
            if key in model.lower():
                size = key
                break
        if size in ("tiny", "base", "small", "medium"):
            size = f"{size}.en"
    else:
        size = size_map.get(model, model)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[pi-voice] Loading whisper model '{size}' on {device}...", file=sys.stderr)
    m = whisper.load_model(size, device=device)
    result = m.transcribe(audio_path, fp16=(device == "cuda"), language="en")
    return result["text"].strip()


def main():
    parser = argparse.ArgumentParser(description="Whisper transcription helper")
    parser.add_argument("audio", help="Path to audio file")
    parser.add_argument("--model", default="base", help="Whisper model name")
    args = parser.parse_args()
    is_mac = platform.system() == "Darwin"
    if is_mac:
        try:
            print(transcribe_mlx(args.audio, args.model))
            return
        except ImportError:
            print("[pi-voice] mlx-whisper not installed, falling back to openai-whisper", file=sys.stderr)
        except Exception as e:
            print(f"[pi-voice] mlx-whisper error: {e}, falling back to openai-whisper", file=sys.stderr)
    try:
        print(transcribe_openai(args.audio, args.model))
    except ImportError:
        print("ERROR: No whisper installation found. Install one of:\n  pip install openai-whisper\n  pip install mlx-whisper  # macOS only", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Transcription failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
`;

const SCRIPT_PATH = ".pi-voice/scripts/transcribe.py";
const TMP_DIR = ".pi-voice/tmp";
const DEFAULT_MODEL = "base";

function loadModel() {
  try {
    return localStorage.getItem("pi-voice-model") || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

function loadPython() {
  try {
    return localStorage.getItem("pi-voice-python") || "";
  } catch {
    return "";
  }
}

function loadDeviceId() {
  try {
    return localStorage.getItem("pi-voice-device-id") || "";
  } catch {
    return "";
  }
}

async function enumerateInputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}

// Candidate Python interpreters probed when no explicit interpreter is set.
// Covers system python, common conda installs, and pipx venvs (the venv name is
// the pipx package: openai-whisper; "whisper" is included as a fallback).
const PYTHON_CANDIDATES = [
  "python3",
  "python",
  "$HOME/miniconda3/bin/python",
  "$HOME/anaconda3/bin/python",
  "$HOME/miniforge3/bin/python",
  "$HOME/.local/share/pipx/venvs/openai-whisper/bin/python",
  "$HOME/.local/share/pipx/venvs/whisper/bin/python",
];

function buildTranscribeCommand(python, scriptPath, recPath, wavPath, model, outPath, errPath) {
  // Pre-convert browser audio to 16 kHz mono WAV with ffmpeg (mirrors the TUI
  // rawToWav step). Avoids Whisper mis-decoding live WebM into silence, which
  // causes hallucinations like "you".
  const ffmpegStep = `ffmpeg -y -hide_banner -i ${shellQuote(recPath)} -vn -ar 16000 -ac 1 ${shellQuote(wavPath)} 2> ${shellQuote(errPath)}`;
  const run = (pyToken) =>
    `${pyToken} ${shellQuote(scriptPath)} ${shellQuote(wavPath)} --model ${shellQuote(model)} > ${shellQuote(outPath)} 2> ${shellQuote(errPath)}`;
  const py = (python || "").trim();
  if (py) {
    // Explicit interpreter: emit raw so the shell expands ~ and $HOME.
    return [
      `${ffmpegStep} || exit 1`,
      run(py),
    ].join("\n");
  }
  // Auto-detect: try each candidate (double-quoted so $HOME expands), use the
  // first that can import whisper (or mlx_whisper), then run transcription.
  const probes = PYTHON_CANDIDATES.map((c) => `"${c}"`).join(" ");
  return [
    `${ffmpegStep} || exit 1`,
    `for PY in ${probes}; do`,
    `  if "$PY" -c 'import whisper' >/dev/null 2>&1 || "$PY" -c 'import mlx_whisper' >/dev/null 2>&1; then`,
    `    ${run('"$PY"')}`,
    `    exit $?`,
    `  fi`,
    `done`,
    `printf '%s\\n' 'ERROR: No Python with whisper/mlx_whisper found. Tried: python3, python, conda (miniconda3/anaconda3/miniforge3), pipx (openai-whisper/whisper). Set the Python path in the Voice panel.' > ${shellQuote(errPath)}`,
    `exit 1`,
  ].join("\n");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Voice controller (module singleton) ─────────────────────────────

class VoiceController {
  constructor() {
    this.state = {
      phase: "idle", // idle | recording | transcribing | done | error
      elapsed: 0,
      transcript: "",
      error: "",
      model: loadModel(),
      python: loadPython(),
      deviceId: loadDeviceId(),
      devices: [],
      deviceLabel: "",
    };
    this.ctx = null; // { files, terminal, workspace, host, prompt }
    this.listeners = new Set();
    this._recorder = null;
    this._stream = null;
    this._chunks = [];
    this._timer = null;
    this._startedAt = 0;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* listener errors are non-fatal */ }
    }
  }

  _set(partial) {
    this.state = { ...this.state, ...partial };
    this._emit();
  }

  setCtx(ctx) {
    // Keep the most recent workspace panel context. The panel renders for the
    // selected workspace/machine, so this tracks the active one.
    this.ctx = ctx;
  }

  setModel(model) {
    this.state.model = model || DEFAULT_MODEL;
    try { localStorage.setItem("pi-voice-model", this.state.model); } catch { /* ok */ }
    this._emit();
  }

  setPython(python) {
    this.state.python = (python || "").trim();
    try { localStorage.setItem("pi-voice-python", this.state.python); } catch { /* ok */ }
    this._emit();
  }

  setDeviceId(deviceId) {
    this.state.deviceId = deviceId || "";
    try { localStorage.setItem("pi-voice-device-id", this.state.deviceId); } catch { /* ok */ }
    this._emit();
  }

  async refreshDevices() {
    const devices = await enumerateInputDevices();
    this._set({ devices });
  }

  canRun() {
    return !!(this.ctx && this.ctx.files && this.ctx.terminal);
  }

  async toggle() {
    if (this.state.phase === "recording") {
      this._stopRecording();
    } else if (this.state.phase === "transcribing") {
      // ignore — let the in-flight transcription finish
    } else {
      await this._startRecording();
    }
  }

  async _startRecording() {
    if (!this.canRun()) {
      this._set({ phase: "error", error: "Open the Voice panel in a workspace first." });
      return;
    }
    let stream;
    try {
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000,
      };
      const selectedId = this.state.deviceId;
      if (selectedId) audioConstraints.deviceId = { exact: selectedId };
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (err) {
      const name = err && err.name ? err.name : "";
      let msg = err && err.message ? err.message : String(err);
      if (name === "NotAllowedError" || name === "SecurityError") {
        msg = "Microphone permission denied. Allow mic access for this site.";
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        msg = "No microphone found.";
      } else if (name === "TypeError" || !navigator.mediaDevices) {
        msg = "Microphone capture requires HTTPS or localhost. pi-web must be served over https:// (or http://localhost) for the browser to allow mic access.";
      }
      this._set({ phase: "error", error: msg });
      return;
    }

    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    const mime = candidates.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) || "";

    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      this._set({ phase: "error", error: `MediaRecorder unavailable: ${err && err.message ? err.message : err}` });
      return;
    }

    this._recorder = recorder;
    this._stream = stream;
    this._chunks = [];
    this._startedAt = Date.now();

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };
    recorder.onstop = () => this._onRecorderStop();
    recorder.start();

    const track = stream.getAudioTracks()[0];
    const label = (track && track.label) ? track.label : "";

    this._timer = setInterval(() => {
      this._set({ elapsed: (Date.now() - this._startedAt) / 1000 });
    }, 250);

    this._set({ phase: "recording", elapsed: 0, transcript: "", error: "", deviceLabel: label });
    // Labels only populate after the first getUserMedia grant, so refresh now.
    this.refreshDevices();
  }

  _stopRecording() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._recorder && this._recorder.state !== "inactive") {
      this._recorder.stop(); // triggers onstop → _onRecorderStop
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
  }

  _audioExt(mime) {
    if (!mime) return "webm";
    if (mime.includes("mp4")) return "mp4";
    if (mime.includes("ogg")) return "ogg";
    return "webm";
  }

  async _onRecorderStop() {
    const recorder = this._recorder;
    const mime = recorder && recorder.mimeType ? recorder.mimeType : "";
    this._recorder = null;
    const elapsed = (Date.now() - this._startedAt) / 1000;
    if (this._chunks.length === 0) {
      this._set({ phase: "error", error: "No audio captured." });
      return;
    }
    if (elapsed < 1.0) {
      this._set({ phase: "error", error: `Recording too short (${elapsed.toFixed(1)}s). Speak for at least ~1 second before clicking Stop.` });
      this._chunks = [];
      return;
    }
    this._set({ phase: "transcribing", transcript: "", error: "" });
    try {
      await this._transcribe(new Blob(this._chunks, { type: mime || "audio/webm" }), this._audioExt(mime));
    } catch (err) {
      this._set({ phase: "error", error: err && err.message ? err.message : String(err) });
    } finally {
      this._chunks = [];
    }
  }

  async _ensureScript(files) {
    try {
      const existing = await files.readFile(SCRIPT_PATH);
      if (existing && !existing.binary && existing.content && existing.content.includes("pi-voice web plugin")) {
        return;
      }
    } catch { /* not present yet */ }
    await files.writeFile(SCRIPT_PATH, TRANSCRIBE_PY);
  }

  async _transcribe(blob, ext) {
    const { files, terminal, prompt } = this.ctx;
    const id = Date.now();
    // Stable "last" paths are kept for diagnostics (overwritten each run); the
    // dated out/err files are cleaned up after reading.
    const recPath = `${TMP_DIR}/last.${ext}`;
    const wavPath = `${TMP_DIR}/last.wav`;
    const outPath = `${TMP_DIR}/out-${id}.txt`;
    const errPath = `${TMP_DIR}/err-${id}.txt`;
    const model = this.state.model || DEFAULT_MODEL;
    const python = this.state.python || "";

    const buf = new Uint8Array(await blob.arrayBuffer());
    await files.writeFile(recPath, buf);
    await this._ensureScript(files);

    const cmd = buildTranscribeCommand(python, SCRIPT_PATH, recPath, wavPath, model, outPath, errPath);
    let handle;
    try {
      handle = await terminal.runCommand({ title: "pi-voice transcribe", command: cmd, open: false });
    } catch (err) {
      await this._cleanup(files, [outPath, errPath]);
      throw new Error(`Failed to start transcription: ${err && err.message ? err.message : err}`);
    }

    const run = await handle.completed;

    if (run.status === "succeeded") {
      let text = "";
      try {
        const out = await files.readFile(outPath);
        text = (out && !out.binary && out.content) ? out.content.trim() : "";
      } catch { /* empty */ }
      await this._cleanup(files, [outPath, errPath]);
      if (!text) {
        this._set({ phase: "error", error: "No speech detected in recording." });
        return;
      }
      if (prompt && typeof prompt.insertText === "function") {
        prompt.insertText(text);
      }
      this._set({ phase: "done", transcript: text, error: "" });
    } else {
      let errText = "";
      try {
        const err = await files.readFile(errPath);
        errText = (err && !err.binary && err.content) ? err.content.trim() : "";
      } catch { /* ignore */ }
      await this._cleanup(files, [outPath, errPath]);
      const detail = errText || `Transcription command exited with status ${run.status}${run.exitCode !== undefined ? ` (code ${run.exitCode})` : ""}.`;
      this._set({ phase: "error", error: detail });
    }
  }

  async _cleanup(files, paths) {
    for (const p of paths) {
      try { await files.deleteFile(p); } catch { /* idempotent */ }
    }
  }

  cancel() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._recorder && this._recorder.state !== "inactive") {
      try { this._recorder.stop(); } catch { /* ok */ }
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    this._recorder = null;
    this._chunks = [];
    this._set({ phase: "idle", elapsed: 0 });
  }
}

const controller = new VoiceController();

// ── Custom element: <pi-voice-panel> ───────────────────────────────
// Plain DOM (no lit dependency) so it renders without importing lit.

class PiVoicePanelElement extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: "open" });
    this._buildDom();
    this._unsubscribe = controller.subscribe(() => this._update());
    this._update();
    controller.refreshDevices();
    this._onDeviceChange = () => controller.refreshDevices();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", this._onDeviceChange);
    }
  }

  disconnectedCallback() {
    if (this._unsubscribe) this._unsubscribe();
    if (this._onDeviceChange && navigator.mediaDevices && navigator.mediaDevices.removeEventListener) {
      navigator.mediaDevices.removeEventListener("devicechange", this._onDeviceChange);
    }
  }

  _buildDom() {
    const s = this.shadowRoot;
    s.innerHTML = `
      <style>
        :host { display: block; padding: 8px 12px 16px; font: 13px/1.45 system-ui, sans-serif; color: var(--pi-text, inherit); }
        .row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        button.mic {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 8px 14px; border-radius: 999px; cursor: pointer;
          border: 1px solid var(--pi-border, #444); background: var(--pi-bg, #222); color: inherit;
          font: inherit; font-weight: 600;
        }
        button.mic:hover { filter: brightness(1.15); }
        button.mic.rec { background: #c0392b; color: #fff; border-color: #c0392b; }
        button.mic:disabled { opacity: .6; cursor: default; }
        .dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; }
        .dot.live { animation: pulse 1s ease-in-out infinite; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
        .timer { font-variant-numeric: tabular-nums; opacity: .85; min-width: 42px; }
        .status { margin: 6px 0 10px; opacity: .8; }
        .model { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
        .model input, .pyrow input {
          flex: 1; padding: 5px 8px; border-radius: 6px;
          border: 1px solid var(--pi-border, #444); background: var(--pi-input-bg, #1a1a1a); color: inherit;
          font: inherit;
        }
        #pvd {
          flex: 1; padding: 5px 8px; border-radius: 6px;
          border: 1px solid var(--pi-border, #444); background: var(--pi-input-bg, #1a1a1a); color: inherit;
          font: inherit; max-width: 100%;
        }
        .devlabel { margin: -4px 0 10px; opacity: .65; font-size: 12px; }
        .preview {
          margin-top: 10px; padding: 10px 12px; border-radius: 8px;
          background: var(--pi-code-bg, rgba(127,127,127,.12)); white-space: pre-wrap; word-break: break-word;
          max-height: 220px; overflow: auto;
        }
        .err { color: #e0746a; }
        .muted { opacity: .6; }
        .hint { margin-top: 10px; opacity: .55; font-size: 12px; }
      </style>
      <div class="row">
        <button class="mic" part="mic">
          <span class="dot"></span>
          <span class="label">Record</span>
          <span class="timer"></span>
        </button>
      </div>
      <div class="status"></div>
      <div class="devlabel"></div>
      <div class="model">
        <label for="pvm">Whisper model</label>
        <input id="pvm" type="text" spellcheck="false" placeholder="base" />
      </div>
      <div class="pyrow">
        <label for="pvp">Python</label>
        <input id="pvp" type="text" spellcheck="false" placeholder="auto (detect conda/pipx)" />
      </div>
      <div class="pyrow">
        <label for="pvd">Mic</label>
        <select id="pvd"></select>
      </div>
      <div class="preview"></div>
      <div class="hint"></div>
    `;
    this._mic = s.querySelector("button.mic");
    this._label = s.querySelector(".label");
    this._timerEl = s.querySelector(".timer");
    this._dot = s.querySelector(".dot");
    this._status = s.querySelector(".status");
    this._modelInput = s.querySelector("#pvm");
    this._pythonInput = s.querySelector("#pvp");
    this._deviceSelect = s.querySelector("#pvd");
    this._devLabel = s.querySelector(".devlabel");
    this._preview = s.querySelector(".preview");
    this._hint = s.querySelector(".hint");

    this._mic.addEventListener("click", () => { controller.toggle(); });
    this._modelInput.addEventListener("change", () => { controller.setModel(this._modelInput.value.trim()); });
    this._pythonInput.addEventListener("change", () => { controller.setPython(this._pythonInput.value); });
    this._deviceSelect.addEventListener("change", () => { controller.setDeviceId(this._deviceSelect.value); });
  }

  _update() {
    const st = controller.state;
    if (document.activeElement !== this._modelInput) {
      this._modelInput.value = st.model;
    }
    if (document.activeElement !== this._pythonInput) {
      this._pythonInput.value = st.python;
    }
    // Populate the mic dropdown.
    if (this._deviceSelect) {
      const opts = [`<option value="">Default</option>`];
      for (const d of st.devices) {
        const name = d.label || `Device ${d.deviceId.slice(0, 6)}`;
        const sel = d.deviceId === st.deviceId ? " selected" : "";
        opts.push(`<option value="${d.deviceId}"${sel}>${name}</option>`);
      }
      const joined = opts.join("");
      if (this._deviceSelect.innerHTML !== joined) this._deviceSelect.innerHTML = joined;
      if (document.activeElement !== this._deviceSelect) this._deviceSelect.value = st.deviceId || "";
    }
    if (this._devLabel) {
      this._devLabel.textContent = st.deviceLabel
        ? `Active mic: ${st.deviceLabel}`
        : (st.devices.length ? "" : "No microphones detected by the browser.");
    }
    const recording = st.phase === "recording";
    const transcribing = st.phase === "transcribing";
    this._mic.classList.toggle("rec", recording);
    this._mic.disabled = transcribing;
    this._label.textContent = recording ? "Stop" : (transcribing ? "Transcribing…" : "Record");
    this._dot.classList.toggle("live", recording);
    this._timerEl.textContent = recording ? fmtTime(st.elapsed) : (transcribing ? "…" : "");

    if (st.phase === "idle") {
      this._status.textContent = "Click Record (or press ⌘⇧V / Ctrl⇧V), speak, then click Stop.";
    } else if (recording) {
      this._status.textContent = `🎤 Recording… ${fmtTime(st.elapsed)} — click Stop when done.`;
    } else if (transcribing) {
      this._status.textContent = "📝 Transcribing with Whisper (first run downloads the model and can take minutes)…";
    } else if (st.phase === "done") {
      this._status.textContent = "✅ Inserted into prompt — review and send.";
    } else if (st.phase === "error") {
      this._status.innerHTML = "";
    }

    if (st.phase === "error" && st.error) {
      this._preview.className = "preview err";
      this._preview.textContent = st.error;
    } else if (st.transcript) {
      this._preview.className = "preview";
      this._preview.textContent = st.transcript;
    } else {
      this._preview.className = "preview muted";
      this._preview.textContent = st.phase === "transcribing" ? "…" : "Transcript will appear here.";
    }

    this._hint.textContent = controller.canRun()
      ? "Audio is captured in your browser; Whisper runs locally on the server."
      : "No workspace context yet — open this panel in a workspace.";
  }
}

if (!customElements.get("pi-voice-panel")) {
  customElements.define("pi-voice-panel", PiVoicePanelElement);
}

// ── Plugin export ──────────────────────────────────────────────────

export default {
  apiVersion: 1,
  name: "pi-voice",
  activate: ({ html }) => ({
    contributions: {
      actions: [
        {
          id: "voice.input",
          title: "Voice input (push to talk)",
          description: "Toggle microphone recording, transcribe with Whisper, and insert into the prompt.",
          shortcut: "mod+shift+v",
          group: "Voice",
          enabled: (ctx) => !!ctx.state.selectedWorkspace,
          run: (ctx) => {
            if (!controller.canRun()) {
              // Ensure the Voice panel is open so it can capture the workspace
              // context that the action needs (files/terminal/prompt).
              ctx.selectWorkspaceTool("pi-voice:workspace.voice");
            }
            controller.toggle();
          },
        },
      ],
      workspacePanels: [
        {
          id: "workspace.voice",
          title: "Voice",
          order: 90,
          render: (context) => {
            // Capture the workspace context for the action + controller.
            controller.setCtx({
              files: context.files,
              terminal: context.terminal,
              workspace: context.workspace,
              host: context.host,
              prompt: context.prompt,
            });
            return html`<pi-voice-panel></pi-voice-panel>`;
          },
        },
      ],
    },
  }),
};