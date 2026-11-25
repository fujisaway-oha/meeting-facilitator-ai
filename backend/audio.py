from __future__ import annotations

import subprocess
import tempfile
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from backend import config

_whisper_instance: Any = None


def check_voicevox() -> dict[str, Any]:
    url = f"{config.VOICEVOX_BASE_URL}/version"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=2.0) as res:
            ver = res.read().decode("utf-8").strip().strip('"')
            return {"connected": True, "version": ver}
    except Exception as exc:
        return {"connected": False, "reason": str(exc)}


def synthesize_voicevox(text: str) -> str | None:
    """VOICEVOX Engineで音声合成し、保存したWAVファイル名を返す（未接続時はNoneを返してブラウザ音声へフォールバック）。"""
    cleaned = text.strip()
    if not cleaned:
        return None

    speaker = config.VOICEVOX_SPEAKER_ID
    query_params = urllib.parse.urlencode({"text": cleaned, "speaker": speaker})
    query_url = f"{config.VOICEVOX_BASE_URL}/audio_query?{query_params}"
    synth_url = f"{config.VOICEVOX_BASE_URL}/synthesis?speaker={speaker}"

    try:
        q_req = urllib.request.Request(query_url, data=b"", method="POST")
        with urllib.request.urlopen(q_req, timeout=15.0) as q_res:
            audio_query_json = q_res.read()

        s_req = urllib.request.Request(
            synth_url,
            data=audio_query_json,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(s_req, timeout=30.0) as s_res:
            wav_bytes = s_res.read()

        cache_dir = config.DATA_DIR / "audio_cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{uuid.uuid4().hex}.wav"
        (cache_dir / filename).write_bytes(wav_bytes)
        return filename
    except Exception:
        return None


def _get_whisper_model() -> Any:
    global _whisper_instance
    if _whisper_instance is None:
        from faster_whisper import WhisperModel  # type: ignore

        model_dir = config.DATA_DIR / "whisper_models"
        model_dir.mkdir(parents=True, exist_ok=True)
        _whisper_instance = WhisperModel(
            config.WHISPER_MODEL,
            device=config.WHISPER_DEVICE,
            compute_type=config.WHISPER_COMPUTE_TYPE,
            download_root=str(model_dir),
        )
    return _whisper_instance


def transcribe_audio_bytes(raw_bytes: bytes, filename_hint: str = "audio.webm") -> str:
    """ブラウザ録音データ（WebM/MP4/WAV等）をffmpegで16kHz WAVに正規化し、faster-whisper + VADで文字起こしする。"""
    suffix = Path(filename_hint).suffix or ".webm"
    with tempfile.TemporaryDirectory() as tmpdir:
        src_path = Path(tmpdir) / f"input{suffix}"
        wav_path = Path(tmpdir) / "normalized.wav"
        src_path.write_bytes(raw_bytes)

        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(src_path),
                "-ar",
                "16000",
                "-ac",
                "1",
                str(wav_path),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        model = _get_whisper_model()
        segments, _ = model.transcribe(
            str(wav_path),
            language="ja",
            initial_prompt="Web制作の打ち合わせ会議。ファシリテーター、議事録、アジェンダ、決定事項、クライアント要望、素材待ち、未決定事項、本日のまとめ、会議を締めてください。",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
        )
        text = "".join(seg.text for seg in segments).strip()
        return text
