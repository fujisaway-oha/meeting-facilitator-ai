from __future__ import annotations

import os
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore
except ImportError:
    yaml = None

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
VIDEOS_DIR = Path(os.getenv("VIDEOS_DIR", str(BASE_DIR / "videos")))
FRONTEND_DIST_DIR = Path(os.getenv("FRONTEND_DIST_DIR", str(BASE_DIR / "frontend_dist")))
CONFIG_PATH = Path(os.getenv("CONFIG_PATH", str(BASE_DIR / "config" / "models.yaml")))

APP_PASSCODE = os.getenv("APP_PASSCODE", "1234")
APP_SECRET_KEY = os.getenv("APP_SECRET_KEY", "local-meeting-facilitator-dev-secret")

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
VOICEVOX_BASE_URL = os.getenv("VOICEVOX_BASE_URL", "http://127.0.0.1:50021").rstrip("/")
VOICEVOX_SPEAKER_ID = int(os.getenv("VOICEVOX_SPEAKER_ID", "3"))

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")


def load_models_config() -> dict[str, Any]:
    default_cfg: dict[str, Any] = {
        "ollama": {"request_timeout_sec": 90, "keep_alive": -1},
        "agents": {
            "scribe": {"model": "llama3.1:latest", "temperature": 0.1},
            "auditor": {"model": "llama3.1:latest", "temperature": 0.2, "interval_utterances": 5},
            "facilitator": {"model": "llama3.1:latest", "temperature": 0.4, "cooldown_sec": 300},
            "summarizer": {"model": "llama3.1:latest", "temperature": 0.2},
        },
    }
    if yaml is not None and CONFIG_PATH.is_file():
        try:
            loaded = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
            if isinstance(loaded, dict):
                default_cfg.update(loaded)
        except Exception:
            pass
    return default_cfg
