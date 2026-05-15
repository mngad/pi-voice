#!/usr/bin/env python3
"""
Cross-platform Whisper transcription helper for pi-voice.

Usage:
    python transcribe.py <audio.wav> [--model <model_name>]

Supports:
    - macOS: mlx-whisper (fast, Apple Silicon optimized) then openai-whisper fallback
    - Linux/Windows: openai-whisper

Install:
    pip install openai-whisper
    # macOS only (optional, for speed):
    pip install mlx-whisper
"""

import argparse
import platform
import sys


def transcribe_mlx(wav_path: str, model: str) -> str:
    """Transcribe using mlx-whisper (macOS, Apple Silicon)."""
    import mlx_whisper
    result = mlx_whisper.transcribe(
        wav_path,
        path_or_hf_repo=model,
        language="en",
    )
    return result["text"].strip()


def transcribe_openai(wav_path: str, model: str) -> str:
    """Transcribe using openai-whisper (cross-platform)."""
    import whisper
    import torch

    # Map user-friendly model names to whisper sizes
    size_map = {
        "tiny": "tiny.en",
        "base": "base.en",
        "small": "small.en",
        "medium": "medium.en",
        "large": "large",
        "large-v3": "large-v3",
        "large-v3-turbo": "large-v3-turbo",
    }

    # If it looks like a HuggingFace model ID (contains "/"),
    # try to extract the size from the name
    if "/" in model:
        size = "base.en"  # default fallback
        for key, val in size_map.items():
            if key in model.lower():
                size = key
                break
        # For HF models that map to standard sizes, use .en variants
        if size in ("tiny", "base", "small", "medium"):
            size = f"{size}.en"
        elif size in ("large", "large-v3", "large-v3-turbo"):
            size = size
    else:
        size = size_map.get(model, model)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[pi-voice] Loading whisper model '{size}' on {device}...", file=sys.stderr)

    whisper_model = whisper.load_model(size, device=device)
    result = whisper_model.transcribe(
        wav_path,
        fp16=(device == "cuda"),
        language="en",
    )
    return result["text"].strip()


def main():
    parser = argparse.ArgumentParser(description="Whisper transcription helper")
    parser.add_argument("audio", help="Path to WAV file")
    parser.add_argument(
        "--model",
        default="base",
        help="Whisper model name (default: base, or mlx-community/whisper-large-v3-turbo on macOS)",
    )
    args = parser.parse_args()

    is_mac = platform.system() == "Darwin"

    if is_mac:
        # Try mlx-whisper first for speed
        try:
            text = transcribe_mlx(args.audio, args.model)
            print(text)
            return
        except ImportError:
            print(
                "[pi-voice] mlx-whisper not installed, falling back to openai-whisper",
                file=sys.stderr,
            )
        except Exception as e:
            print(
                f"[pi-voice] mlx-whisper error: {e}, falling back to openai-whisper",
                file=sys.stderr,
            )

    # Fallback to openai-whisper (cross-platform)
    try:
        text = transcribe_openai(args.audio, args.model)
        print(text)
    except ImportError:
        print(
            "ERROR: No whisper installation found.\n"
            "Install one of:\n"
            "  pip install openai-whisper\n"
            "  pip install mlx-whisper  # macOS only",
            file=sys.stderr,
        )
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Transcription failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
