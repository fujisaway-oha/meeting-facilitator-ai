from __future__ import annotations

import asyncio
from collections import defaultdict
from pathlib import Path
from typing import Any

from fastapi import (
    Cookie,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import agents, audio, auth, config, db

app = FastAPI(title="AI Meeting Facilitator MVP", version="0.1.0")


class ConnectionManager:
    def __init__(self) -> None:
        self._rooms: dict[str, set[WebSocket]] = defaultdict(set)

    async def connect(self, meeting_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self._rooms[meeting_id].add(ws)

    def disconnect(self, meeting_id: str, ws: WebSocket) -> None:
        self._rooms[meeting_id].discard(ws)

    async def broadcast(self, meeting_id: str, event: str, payload: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        message = {"event": event, "data": payload}
        for ws in list(self._rooms.get(meeting_id, set())):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(meeting_id, ws)


ws_manager = ConnectionManager()


@app.on_event("startup")
def on_startup() -> None:
    db.init_db()
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
    audio.cleanup_audio_cache()


def _ensure_meeting_active(meeting_id: str) -> dict[str, Any]:
    """完了済み会議への変更を防ぐガード。存在しなければ404、完了済みなら409を返す。"""
    try:
        detail = db.get_meeting_detail(meeting_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="会議が見つかりません。")
    if detail["meeting"].get("status") == "completed":
        raise HTTPException(
            status_code=409,
            detail="この会議は完了済みのため変更できません。ロビーから新しい会議を作成してください。",
        )
    return detail


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.url.path.startswith("/api/"):
        sec_site = request.headers.get("sec-fetch-site")
        if sec_site and sec_site not in ("same-origin", "same-site", "none"):
            return JSONResponse({"detail": "Cross-site requests forbidden"}, status_code=403)

    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


# --- Request Schemas ---
class LoginRequest(BaseModel):
    passcode: str


class CreateProjectRequest(BaseModel):
    name: str
    client_name: str = ""


class CreateMeetingRequest(BaseModel):
    project_id: str
    title: str
    agenda: str = ""
    duration_minutes: int = 45
    carry_over: bool = True


class UtteranceRequest(BaseModel):
    text: str
    speaker: str = "参加者"
    model: str | None = None
    use_mock: bool = False


class BoardItemPatchRequest(BaseModel):
    item_id: str | None = None
    category: str
    content: str
    is_locked: bool = True


class FacilitateRequest(BaseModel):
    remaining_minutes: int = 15
    question: str = ""
    model: str | None = None
    use_mock: bool = False


class SummarizeRequest(BaseModel):
    model: str | None = None
    use_mock: bool = False


# --- Auth Endpoints ---
@app.post("/api/auth/login")
def login(body: LoginRequest, response: Response) -> dict[str, Any]:
    if not auth.verify_passcode(body.passcode):
        raise HTTPException(status_code=401, detail="パスコードが正しくありません。")
    token = auth.create_session_token()
    response.set_cookie(
        key=auth.COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=auth.SESSION_TTL_SEC,
        path="/",
    )
    return {"authenticated": True}


@app.post("/api/auth/logout")
def logout(response: Response) -> dict[str, Any]:
    response.delete_cookie(key=auth.COOKIE_NAME, path="/")
    return {"authenticated": False}


@app.get("/api/auth/me")
def auth_me(mf_session: str | None = Cookie(default=None)) -> dict[str, Any]:
    return {"authenticated": auth.is_valid_session_token(mf_session)}


# --- Health & Environment ---
@app.get("/api/health", dependencies=[Depends(auth.require_auth)])
def health() -> dict[str, Any]:
    ollama_status = agents.check_ollama()
    voicevox_status = audio.check_voicevox()
    has_videos = (config.VIDEOS_DIR / "idle.mp4").is_file() and (
        config.VIDEOS_DIR / "talk.mp4"
    ).is_file()
    return {
        "ollama": ollama_status,
        "voicevox": voicevox_status,
        "whisper": {
            "model": config.WHISPER_MODEL,
            "device": config.WHISPER_DEVICE,
        },
        "has_custom_videos": has_videos,
        "models_config": config.load_models_config().get("agents", {}),
    }


# --- Projects & Meetings ---
@app.get("/api/projects", dependencies=[Depends(auth.require_auth)])
def api_list_projects() -> dict[str, Any]:
    return {"projects": db.list_projects()}


@app.post("/api/projects", dependencies=[Depends(auth.require_auth)])
def api_create_project(body: CreateProjectRequest) -> dict[str, Any]:
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="案件名を入力してください。")
    return {"project": db.create_project(body.name, body.client_name)}


@app.get("/api/meetings", dependencies=[Depends(auth.require_auth)])
def api_list_meetings(project_id: str | None = None) -> dict[str, Any]:
    return {"meetings": db.list_meetings(project_id)}


@app.post("/api/meetings", dependencies=[Depends(auth.require_auth)])
def api_create_meeting(body: CreateMeetingRequest) -> dict[str, Any]:
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="会議タイトルを入力してください。")
    return db.create_meeting(
        project_id=body.project_id,
        title=body.title,
        agenda=body.agenda,
        duration_minutes=body.duration_minutes,
        carry_over=body.carry_over,
    )


@app.get("/api/meetings/{meeting_id}", dependencies=[Depends(auth.require_auth)])
def api_get_meeting(meeting_id: str) -> dict[str, Any]:
    try:
        return db.get_meeting_detail(meeting_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="会議が見つかりません。")


# --- Utterances & Whisper Audio ---
async def _process_utterance_and_scribe(
    meeting_id: str,
    text: str,
    speaker: str,
    source: str,
    model: str | None,
    use_mock: bool,
) -> dict[str, Any]:
    utterance = db.add_utterance(meeting_id, text=text, speaker=speaker, source=source)
    await ws_manager.broadcast(meeting_id, "utterance.created", {"utterance": utterance})
    await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "thinking"})

    detail = db.get_meeting_detail(meeting_id)
    new_plain_board = await asyncio.to_thread(
        agents.run_scribe,
        meeting_id,
        detail["meeting"]["agenda"],
        detail["utterances"],
        detail["board"],
        model,
        use_mock,
    )
    updated_board = db.sync_board_from_scribe(meeting_id, new_plain_board)
    await ws_manager.broadcast(meeting_id, "board.updated", {"board": updated_board})
    await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "idle"})
    return {"utterance": utterance, "board": updated_board}


@app.post("/api/meetings/{meeting_id}/utterances", dependencies=[Depends(auth.require_auth)])
async def api_add_utterance(meeting_id: str, body: UtteranceRequest) -> dict[str, Any]:
    _ensure_meeting_active(meeting_id)
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="発言テキストが空です。")
    try:
        return await _process_utterance_and_scribe(
            meeting_id=meeting_id,
            text=body.text,
            speaker=body.speaker,
            source="manual",
            model=body.model,
            use_mock=body.use_mock,
        )
    except Exception as exc:
        await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "idle"})
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/api/meetings/{meeting_id}/audio", dependencies=[Depends(auth.require_auth)])
async def api_upload_audio(
    meeting_id: str,
    file: UploadFile = File(...),
    speaker: str = Form("参加者"),
    model: str = Form(""),
    use_mock: bool = Form(False),
) -> dict[str, Any]:
    _ensure_meeting_active(meeting_id)
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="音声データが空です。")

    await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "thinking"})
    try:
        text = await asyncio.to_thread(
            audio.transcribe_audio_bytes, raw, file.filename or "speech.webm"
        )
    except Exception as exc:
        await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "idle"})
        raise HTTPException(status_code=500, detail=f"Whisper文字起こしエラー: {exc}")

    if not text.strip():
        await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "idle"})
        return {"transcribed_text": "", "skipped": True}

    result = await _process_utterance_and_scribe(
        meeting_id=meeting_id,
        text=text,
        speaker=speaker,
        source="stt",
        model=model or None,
        use_mock=use_mock,
    )
    result["transcribed_text"] = text
    return result


@app.post("/api/meetings/{meeting_id}/voice-chat", dependencies=[Depends(auth.require_auth)])
async def api_voice_chat(
    meeting_id: str,
    file: UploadFile = File(...),
    remaining_minutes: int = Form(15),
    model: str = Form(""),
    use_mock: bool = Form(False),
) -> dict[str, Any]:
    """マイク音声をWhisperで文字起こしし、ボード更新＋AIファシリテーターのVOICEVOX音声返答を一括実行する。"""
    _ensure_meeting_active(meeting_id)
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="音声データが空です。")

    await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "thinking"})
    try:
        user_text = await asyncio.to_thread(
            audio.transcribe_audio_bytes, raw, file.filename or "talk.webm"
        )
    except Exception as exc:
        await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "idle"})
        raise HTTPException(status_code=500, detail=f"Whisper文字起こしエラー: {exc}")

    if not user_text.strip():
        await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "idle"})
        return {"skipped": True, "transcribed_text": ""}

    try:
        detail = db.get_meeting_detail(meeting_id)

        # 声で「会議を締めて／終わりにします／まとめて」と言われた場合はまとめ役を自動実行
        if agents.is_close_meeting_request(user_text):
            utterance = db.add_utterance(meeting_id, text=user_text, speaker="進行指示", source="stt")
            await ws_manager.broadcast(meeting_id, "utterance.created", {"utterance": utterance})
            sum_res = await asyncio.to_thread(
                agents.run_summarizer,
                meeting_id,
                detail["meeting"]["title"],
                detail["meeting"]["agenda"],
                detail["utterances"],
                detail["board"],
                model or None,
                use_mock,
            )
            db.complete_meeting_summary(meeting_id, sum_res["markdown_report"])
            audio.cleanup_audio_cache()
            wav_name = await asyncio.to_thread(audio.synthesize_voicevox, sum_res["spoken_closing"])
            audio_url = f"/api/audio/{wav_name}" if wav_name else None
            payload = {
                "skipped": False,
                "is_summary": True,
                "transcribed_text": user_text,
                "utterance": utterance,
                "spoken_message": sum_res["spoken_closing"],
                "next_focus": "会議の締め・確定議事録を表示中",
                "next_actions": sum_res["next_actions"],
                "markdown_report": sum_res["markdown_report"],
                "audio_url": audio_url,
                "board": detail["board"],
                "model": sum_res["model"],
            }
            await ws_manager.broadcast(
                meeting_id,
                "meeting.completed",
                {"meeting_id": meeting_id, "summary_markdown": sum_res["markdown_report"]},
            )
            await ws_manager.broadcast(meeting_id, "facilitator.speak", payload)
            return payload

        utterance = db.add_utterance(meeting_id, text=user_text, speaker="音声対話", source="stt")
        await ws_manager.broadcast(meeting_id, "utterance.created", {"utterance": utterance})
        detail = db.get_meeting_detail(meeting_id)

        turn = await asyncio.to_thread(
            agents.run_voice_turn,
            meeting_id,
            user_text,
            detail["meeting"]["agenda"],
            detail["utterances"],
            detail["board"],
            remaining_minutes,
            model or None,
            use_mock,
        )

        # ローカルLLMが文脈から「締め・まとめ依頼(summarize)」と判定した場合もまとめ役へ引き継ぐ
        if turn.get("action") == "summarize":
            sum_res = await asyncio.to_thread(
                agents.run_summarizer,
                meeting_id,
                detail["meeting"]["title"],
                detail["meeting"]["agenda"],
                detail["utterances"],
                detail["board"],
                model or None,
                use_mock,
            )
            db.complete_meeting_summary(meeting_id, sum_res["markdown_report"])
            audio.cleanup_audio_cache()
            wav_name = await asyncio.to_thread(audio.synthesize_voicevox, sum_res["spoken_closing"])
            audio_url = f"/api/audio/{wav_name}" if wav_name else None
            payload = {
                "skipped": False,
                "is_summary": True,
                "transcribed_text": user_text,
                "utterance": utterance,
                "spoken_message": sum_res["spoken_closing"],
                "next_focus": "会議の締め・確定議事録を表示中",
                "next_actions": sum_res["next_actions"],
                "markdown_report": sum_res["markdown_report"],
                "audio_url": audio_url,
                "board": detail["board"],
                "model": sum_res["model"],
            }
            await ws_manager.broadcast(
                meeting_id,
                "meeting.completed",
                {"meeting_id": meeting_id, "summary_markdown": sum_res["markdown_report"]},
            )
            await ws_manager.broadcast(meeting_id, "facilitator.speak", payload)
            return payload

        updated_board = db.sync_board_from_scribe(meeting_id, turn["board"])
        await ws_manager.broadcast(meeting_id, "board.updated", {"board": updated_board})

        wav_name = await asyncio.to_thread(audio.synthesize_voicevox, turn["spoken_message"])
        audio_url = f"/api/audio/{wav_name}" if wav_name else None
        payload = {
            "skipped": False,
            "is_summary": False,
            "transcribed_text": user_text,
            "utterance": utterance,
            "spoken_message": turn["spoken_message"],
            "next_focus": turn["next_focus"],
            "audio_url": audio_url,
            "board": updated_board,
            "model": turn["model"],
        }
        await ws_manager.broadcast(meeting_id, "facilitator.speak", payload)
        return payload
    except Exception as exc:
        await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "idle"})
        raise HTTPException(status_code=502, detail=str(exc))


# --- Manual Board Edit / Lock ---
@app.patch("/api/meetings/{meeting_id}/board-items", dependencies=[Depends(auth.require_auth)])
async def api_patch_board_item(meeting_id: str, body: BoardItemPatchRequest) -> dict[str, Any]:
    _ensure_meeting_active(meeting_id)
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="項目内容を入力してください。")
    board = db.upsert_manual_board_item(
        meeting_id=meeting_id,
        category=body.category,
        content=body.content,
        item_id=body.item_id,
        is_locked=body.is_locked,
    )
    await ws_manager.broadcast(meeting_id, "board.updated", {"board": board})
    return {"board": board}


@app.delete("/api/meetings/{meeting_id}/board-items/{item_id}", dependencies=[Depends(auth.require_auth)])
async def api_delete_board_item(meeting_id: str, item_id: str) -> dict[str, Any]:
    _ensure_meeting_active(meeting_id)
    board = db.delete_board_item(meeting_id, item_id)
    await ws_manager.broadcast(meeting_id, "board.updated", {"board": board})
    return {"board": board}


# --- Facilitator & Summarizer ---
@app.post("/api/meetings/{meeting_id}/facilitate", dependencies=[Depends(auth.require_auth)])
async def api_facilitate(meeting_id: str, body: FacilitateRequest) -> dict[str, Any]:
    detail = db.get_meeting_detail(meeting_id)
    await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "thinking"})
    try:
        res = await asyncio.to_thread(
            agents.run_facilitator,
            meeting_id,
            detail["meeting"]["agenda"],
            detail["utterances"],
            detail["board"],
            body.remaining_minutes,
            body.question,
            body.model,
            body.use_mock,
        )
        wav_name = await asyncio.to_thread(audio.synthesize_voicevox, res["spoken_message"])
        audio_url = f"/api/audio/{wav_name}" if wav_name else None
        payload = {
            "spoken_message": res["spoken_message"],
            "next_focus": res["next_focus"],
            "audio_url": audio_url,
            "model": res["model"],
        }
        await ws_manager.broadcast(meeting_id, "facilitator.speak", payload)
        return payload
    except Exception as exc:
        await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "idle"})
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/api/meetings/{meeting_id}/summarize", dependencies=[Depends(auth.require_auth)])
async def api_summarize(meeting_id: str, body: SummarizeRequest) -> dict[str, Any]:
    detail = _ensure_meeting_active(meeting_id)
    await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "thinking"})
    try:
        res = await asyncio.to_thread(
            agents.run_summarizer,
            meeting_id,
            detail["meeting"]["title"],
            detail["meeting"]["agenda"],
            detail["utterances"],
            detail["board"],
            body.model,
            body.use_mock,
        )
        db.complete_meeting_summary(meeting_id, res["markdown_report"])
        audio.cleanup_audio_cache()
        wav_name = await asyncio.to_thread(audio.synthesize_voicevox, res["spoken_closing"])
        audio_url = f"/api/audio/{wav_name}" if wav_name else None
        payload = {
            "spoken_closing": res["spoken_closing"],
            "next_actions": res["next_actions"],
            "markdown_report": res["markdown_report"],
            "audio_url": audio_url,
            "model": res["model"],
        }
        await ws_manager.broadcast(
            meeting_id,
            "meeting.completed",
            {"meeting_id": meeting_id, "summary_markdown": res["markdown_report"]},
        )
        await ws_manager.broadcast(meeting_id, "facilitator.speak", {
            "spoken_message": res["spoken_closing"],
            "next_focus": "会議のまとめ完了",
            "audio_url": audio_url,
            "model": res["model"],
        })
        return payload
    except Exception as exc:
        await ws_manager.broadcast(meeting_id, "avatar.state", {"state": "idle"})
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/audio/{filename}", dependencies=[Depends(auth.require_auth)])
def api_get_audio(filename: str) -> FileResponse:
    safe_name = Path(filename).name
    target = config.DATA_DIR / "audio_cache" / safe_name
    if not target.is_file():
        raise HTTPException(status_code=404, detail="音声ファイルが見つかりません。")
    return FileResponse(str(target), media_type="audio/wav")


# --- WebSocket ---
@app.websocket("/ws/meetings/{meeting_id}")
async def ws_meeting(websocket: WebSocket, meeting_id: str) -> None:
    token = websocket.cookies.get(auth.COOKIE_NAME)
    if not auth.is_valid_session_token(token):
        await websocket.close(code=1008)
        return

    await ws_manager.connect(meeting_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(meeting_id, websocket)


# --- Static Videos & Built SPA ---
config.VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/videos", StaticFiles(directory=str(config.VIDEOS_DIR)), name="videos")

if config.FRONTEND_DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIST_DIR), html=True), name="spa")
