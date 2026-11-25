from __future__ import annotations

import json
import time
import urllib.request
from typing import Any

from backend import config, db


def check_ollama() -> dict[str, Any]:
    url = f"{config.OLLAMA_BASE_URL}/api/tags"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=2.5) as res:
            data = json.loads(res.read().decode("utf-8"))
            models = [m.get("name", "") for m in data.get("models", []) if m.get("name")]
            return {"connected": True, "models": models, "base_url": config.OLLAMA_BASE_URL}
    except Exception as exc:
        return {"connected": False, "models": [], "reason": str(exc), "base_url": config.OLLAMA_BASE_URL}


def _resolve_agent_params(role: str, model_override: str | None = None) -> tuple[str, float, int, int]:
    cfg = config.load_models_config()
    ollama_cfg = cfg.get("ollama", {})
    role_cfg = cfg.get("agents", {}).get(role, {})
    model = (model_override or "").strip() or str(role_cfg.get("model", "llama3.1:latest"))
    temp = float(role_cfg.get("temperature", 0.2))
    timeout = int(ollama_cfg.get("request_timeout_sec", 90))
    keep_alive = int(ollama_cfg.get("keep_alive", -1))
    return model, temp, timeout, keep_alive


def _call_ollama_json_with_retry(
    meeting_id: str,
    role: str,
    messages: list[dict[str, str]],
    model_override: str | None = None,
    max_retries: int = 2,
) -> tuple[dict[str, Any], str]:
    model, temp, timeout, keep_alive = _resolve_agent_params(role, model_override)
    url = f"{config.OLLAMA_BASE_URL}/api/chat"
    last_err: Exception | None = None

    for _ in range(max_retries + 1):
        started = time.perf_counter()
        payload = {
            "model": model,
            "stream": False,
            "format": "json",
            "keep_alive": keep_alive,
            "options": {"temperature": temp},
            "messages": messages,
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = json.loads(res.read().decode("utf-8"))
            parsed = json.loads(raw.get("message", {}).get("content", "{}"))
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            db.log_agent_run(meeting_id, role, model, elapsed_ms, True)
            return parsed, model
        except Exception as exc:
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            db.log_agent_run(meeting_id, role, model, elapsed_ms, False)
            last_err = exc

    raise RuntimeError(f"Ollama ({model}) 呼び出しに失敗しました: {last_err}")


def _plain_board(board: dict[str, list[dict[str, Any]]]) -> dict[str, list[str]]:
    return {
        cat: [item["content"] for item in board.get(cat, [])]
        for cat in db.CATEGORIES
    }


def _format_utterances(utterances: list[dict[str, Any]]) -> str:
    if not utterances:
        return "（まだ発言はありません）"
    return "\n".join(
        f"[{u.get('seq_no', '')}] {u.get('speaker', '参加者')}: {u.get('text', '')}"
        for u in utterances
    )


def run_scribe(
    meeting_id: str,
    agenda: str,
    utterances: list[dict[str, Any]],
    current_board: dict[str, list[dict[str, Any]]],
    model_override: str | None = None,
    use_mock: bool = False,
) -> dict[str, list[str]]:
    plain = _plain_board(current_board)
    if use_mock:
        return _mock_scribe(utterances, plain)

    system_prompt = (
        "あなたは対面会議に同席している優秀な『書記エージェント』です。"
        "会議アジェンダ・現在の議事ボード（前回からの引き継ぎ項目を含む）・発言ログを読み、"
        "最新状態の4分類ボードをJSONのみで出力してください。\n"
        "出力スキーマ:\n"
        '{"decisions":["決定・合意事項"],"requests":["クライアント要望"],'
        '"waiting_materials":["素材待ち・支給予定"],"undecided":["未決定事項・確認待ち"]}\n'
        "※未決定だった項目が合意された場合は undecided から外し decisions へ移動してください。"
    )
    user_prompt = (
        f"【アジェンダ】\n{agenda}\n\n"
        f"【現在のボード】\n{json.dumps(plain, ensure_ascii=False)}\n\n"
        f"【発言ログ】\n{_format_utterances(utterances)}"
    )
    parsed, _ = _call_ollama_json_with_retry(
        meeting_id,
        "scribe",
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        model_override=model_override,
    )
    normalized: dict[str, list[str]] = {c: [] for c in db.CATEGORIES}
    for cat in db.CATEGORIES:
        val = parsed.get(cat, plain.get(cat, []))
        if isinstance(val, list):
            normalized[cat] = [str(x).strip() for x in val if str(x).strip()]
    return normalized


def run_facilitator(
    meeting_id: str,
    agenda: str,
    utterances: list[dict[str, Any]],
    current_board: dict[str, list[dict[str, Any]]],
    remaining_minutes: int = 15,
    question: str = "",
    model_override: str | None = None,
    use_mock: bool = False,
) -> dict[str, str]:
    plain = _plain_board(current_board)
    if use_mock:
        return _mock_facilitator(plain, remaining_minutes, question)

    system_prompt = (
        "あなたは会議室のモニターから参加している『進行役（ファシリテーター）エージェント』です。"
        "spoken_message はVOICEVOXでそのまま音声読み上げされるため、"
        "箇条書き記号やアスタリスク(*)を絶対に使わず、丁寧で自然な話し言葉で2〜3文以内（120文字以内）にしてください。\n"
        "出力スキーマ:\n"
        '{"spoken_message":"音声で話す進行コメント","next_focus":"次に決めるべき短い論点見出し(30文字以内)"}'
    )
    trigger = (
        f"参加者からの呼びかけ: {question}"
        if question.strip()
        else f"残り時間 {remaining_minutes} 分の進行チェック"
    )
    user_prompt = (
        f"【アジェンダ】\n{agenda}\n\n"
        f"【状況】{trigger}\n\n"
        f"【現在のボード】\n{json.dumps(plain, ensure_ascii=False)}\n\n"
        f"【直近の発言】\n{_format_utterances(utterances[-10:])}"
    )
    parsed, used_model = _call_ollama_json_with_retry(
        meeting_id,
        "facilitator",
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        model_override=model_override,
    )
    return {
        "spoken_message": str(
            parsed.get("spoken_message", "ここまでの論点を整理しました。未決定事項の確認を進めましょう。")
        ).strip(),
        "next_focus": str(parsed.get("next_focus", "未決定事項の確認")).strip(),
        "model": used_model,
    }


def is_close_meeting_request(text: str) -> bool:
    """発話が『会議の締め・終了・まとめ依頼』かどうかを判定する（同音異義語の『閉めて』も考慮）。"""
    t = text.strip()
    close_keywords = (
        "締めて",
        "閉めて",
        "締めくく",
        "終わりにし",
        "終わらし",
        "会議を終わ",
        "会議終了",
        "まとめて",
        "まとめをお願い",
        "総括して",
    )
    return any(k in t for k in close_keywords)


def run_voice_turn(
    meeting_id: str,
    user_text: str,
    agenda: str,
    utterances: list[dict[str, Any]],
    current_board: dict[str, list[dict[str, Any]]],
    remaining_minutes: int = 15,
    model_override: str | None = None,
    use_mock: bool = False,
) -> dict[str, Any]:
    """音声で話しかけられた際、必要なら議事ボードも更新しつつ自然な音声返答を返す。"""
    plain = _plain_board(current_board)
    if use_mock:
        return _mock_voice_turn(user_text, utterances, plain, remaining_minutes)

    system_prompt = (
        "あなたは会議室のモニターにいる『AIファシリテーター』です。"
        "参加者から声で話しかけられました。相手の発言意図に応じて action を判定し、自然な話し言葉で返答してください。\n"
        "- 会議を終了・締める・全体まとめを求められた場合: action を \"summarize\" にする\n"
        "- 進行・話題振り・質問・雑談などボード記録不要の呼びかけの場合: action を \"facilitate\" にする\n"
        "- 会議の決定事項・要望・素材予定・未決課題の発言が含まれる場合: action を \"record_and_reply\" にする\n"
        "spoken_message はVOICEVOXで音声合成されるため、箇条書き記号やアスタリスク(*)は使わず、"
        "自然な話し言葉で2〜3文以内（120文字以内）にしてください。\n"
        "出力スキーマ:\n"
        '{"action":"summarize または facilitate または record_and_reply",'
        '"spoken_message":"相手への自然な音声返答","next_focus":"現在の注目論点(30文字以内)"}'
    )
    user_prompt = (
        f"【アジェンダ】\n{agenda}\n"
        f"【残り時間】{remaining_minutes}分\n"
        f"【現在の議事ボード】\n{json.dumps(plain, ensure_ascii=False)}\n"
        f"【直近の会話ログ】\n{_format_utterances(utterances[-8:])}\n\n"
        f"【今の相手の発言】\n{user_text}"
    )
    parsed, used_model = _call_ollama_json_with_retry(
        meeting_id,
        "facilitator",
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        model_override=model_override,
    )
    action = str(parsed.get("action", "facilitate")).strip()
    new_board = plain
    if action == "record_and_reply":
        new_board = run_scribe(
            meeting_id=meeting_id,
            agenda=agenda,
            utterances=utterances,
            current_board=current_board,
            model_override=model_override,
            use_mock=False,
        )

    return {
        "action": action,
        "board": new_board,
        "spoken_message": str(parsed.get("spoken_message", "承知しました。")).strip(),
        "next_focus": str(parsed.get("next_focus", "議論の継続")).strip(),
        "model": used_model,
    }


def run_summarizer(
    meeting_id: str,
    title: str,
    agenda: str,
    utterances: list[dict[str, Any]],
    current_board: dict[str, list[dict[str, Any]]],
    model_override: str | None = None,
    use_mock: bool = False,
) -> dict[str, Any]:
    plain = _plain_board(current_board)
    if use_mock:
        closing, actions = _mock_summarizer(plain)
        used_model = "mock"
    else:
        system_prompt = (
            "あなたは会議の『まとめ役エージェント』です。spoken_closing は音声合成で読み上げるため、"
            "記号を使わず3文以内の自然な話し言葉にしてください。\n"
            "出力スキーマ:\n"
            '{"spoken_closing":"会議締めの口頭コメント","next_actions":["【担当/対象】やること（期限目安）"]}'
        )
        user_prompt = (
            f"【会議名】{title}\n【アジェンダ】\n{agenda}\n\n"
            f"【最終ボード】\n{json.dumps(plain, ensure_ascii=False)}\n\n"
            f"【発言ログ】\n{_format_utterances(utterances)}"
        )
        parsed, used_model = _call_ollama_json_with_retry(
            meeting_id,
            "summarizer",
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            model_override=model_override,
        )
        closing = str(
            parsed.get("spoken_closing", "本日の打ち合わせ内容を整理しました。議事録をご確認ください。")
        ).strip()
        raw_actions = parsed.get("next_actions", [])
        actions = [str(a).strip() for a in raw_actions if str(a).strip()] if isinstance(raw_actions, list) else []

    md = build_markdown(title, agenda, plain, actions, utterances)
    return {
        "spoken_closing": closing,
        "next_actions": actions,
        "markdown_report": md,
        "model": used_model,
    }


def build_markdown(
    title: str,
    agenda: str,
    board: dict[str, list[str]],
    next_actions: list[str],
    utterances: list[dict[str, Any]],
) -> str:
    def _b(items: list[str]) -> str:
        return "\n".join(f"- {x}" for x in items) if items else "- なし"

    return "\n".join(
        [
            f"# {title}",
            "",
            "## アジェンダ",
            agenda.strip() or "（未設定）",
            "",
            "## 決定事項",
            _b(board.get("decisions", [])),
            "",
            "## クライアント要望",
            _b(board.get("requests", [])),
            "",
            "## 素材待ち・支給予定（次回引き継ぎ対象）",
            _b(board.get("waiting_materials", [])),
            "",
            "## 未決定事項・要確認（次回引き継ぎ対象）",
            _b(board.get("undecided", [])),
            "",
            "## ネクストアクション",
            _b(next_actions),
            "",
            "## 発言ログ",
            _format_utterances(utterances),
            "",
        ]
    )


def _mock_scribe(utterances: list[dict[str, Any]], base: dict[str, list[str]]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {c: list(base.get(c, [])) for c in db.CATEGORIES}
    seen = {x for items in out.values() for x in items}
    for u in utterances:
        t = str(u.get("text", "")).strip()
        if not t or t in seen:
            continue
        seen.add(t)
        if any(k in t for k in ("支給", "送付", "素材", "写真", "ロゴ", "待ち")):
            out["waiting_materials"].append(t)
        elif any(k in t for k in ("未定", "確認後", "検討", "どうするか", "相談")):
            out["undecided"].append(t)
        elif any(k in t for k in ("決定", "決まり", "合意", "進めます", "OK")):
            out["decisions"].append(t)
        else:
            out["requests"].append(t)
    return out


def _mock_facilitator(board: dict[str, list[str]], remaining: int, question: str) -> dict[str, str]:
    u = board.get("undecided", [])
    w = board.get("waiting_materials", [])
    if question.strip():
        msg = f"ここまでの整理をお伝えします。要望が{len(board.get('requests', []))}件、素材待ちが{len(w)}件、未決定事項が{len(u)}件です。"
        if u:
            msg += f"特に、{u[0]}について確認担当を決めておくとスムーズです。"
        focus = u[0][:28] if u else "全体スケジュールの確認"
    elif u:
        msg = f"残り{remaining}分となりました。未決定事項が{len(u)}件あります。先に{u[0]}の期限と担当だけ決めておきませんか？"
        focus = f"未決定事項の解消（残り{len(u)}件）"
    else:
        msg = f"残り{remaining}分です。主要な論点は整理できていますので、素材支給スケジュールの最終確認に進みましょう。"
        focus = "素材支給スケジュールの最終確認"
    return {"spoken_message": msg, "next_focus": focus, "model": "mock"}


def _mock_summarizer(board: dict[str, list[str]]) -> tuple[str, list[str]]:
    closing = (
        f"本日の打ち合わせお疲れ様でした。決定事項{len(board.get('decisions', []))}件、"
        f"ご要望{len(board.get('requests', []))}件、次回へ引き継ぐ確認事項・素材待ちは"
        f"{len(board.get('waiting_materials', [])) + len(board.get('undecided', []))}件です。"
    )
    actions = [f"【素材支給】{x}" for x in board.get("waiting_materials", [])] + [
        f"【要確認】{x}" for x in board.get("undecided", [])
    ]
    if not actions:
        actions.append("【制作担当】決定事項をもとに画面構成案を作成")
    return closing, actions


def _mock_voice_turn(
    user_text: str,
    utterances: list[dict[str, Any]],
    base_board: dict[str, list[str]],
    remaining: int,
) -> dict[str, Any]:
    t = user_text.strip()
    if is_close_meeting_request(t):
        return {
            "action": "summarize",
            "board": base_board,
            "spoken_message": "",
            "next_focus": "会議の締め・まとめ出力",
            "model": "mock",
        }

    is_greeting = any(k in t for k in ("こんにちは", "おはよう", "こんばんは", "よろしく", "聞こえ", "テスト"))
    is_facilitation = any(k in t for k in ("進めて", "進行", "振って", "ファシリ", "走りテータ", "アジェンダ"))
    is_question = any(k in t for k in ("教えて", "何があ", "どうなっ", "整理して", "状況", "？", "?"))

    if is_greeting:
        return {
            "action": "facilitate",
            "board": base_board,
            "spoken_message": "こんにちは！しっかり聞こえていますよ。本日の打ち合わせの進行と記録を担当しますので、何でも話しかけてくださいね。",
            "next_focus": "議題の確認・ヒアリング開始",
            "model": "mock",
        }

    if is_facilitation:
        undecided = base_board.get("undecided", [])
        if undecided:
            msg = f"承知しました。現在、{undecided[0]}が未決定になっていますので、こちらについてご担当者様からご意見を伺えますでしょうか？（※より柔軟な進行会話はローカルLLM接続時に有効になります）"
        else:
            msg = "承知しました。それではアジェンダに沿って、まずはトップページの構成やご希望から順番に伺っていきましょう。"
        return {
            "action": "facilitate",
            "board": base_board,
            "spoken_message": msg,
            "next_focus": "アジェンダに沿った意見ヒアリング",
            "model": "mock",
        }

    if is_question:
        if "未決" in t or "確認" in t:
            items = base_board.get("undecided", [])
            msg = (
                f"現在の未決定事項は{len(items)}件です。{items[0]}などが残っています。"
                if items
                else "現在、未決定事項はまだ登録されていません。"
            )
        elif "素材" in t or "写真" in t:
            items = base_board.get("waiting_materials", [])
            msg = (
                f"素材待ちは{len(items)}件です。{items[0]}を予定しています。"
                if items
                else "現在、素材待ちの項目はありません。"
            )
        else:
            res = _mock_facilitator(base_board, remaining, t)
            msg = res["spoken_message"]
        return {
            "board": base_board,
            "spoken_message": msg,
            "next_focus": "論点の整理・確認",
            "model": "mock",
        }

    # 会議の具体的な発言だった場合はボードへ追加して復唱返答する
    updated = _mock_scribe(utterances, base_board)
    if any(k in t for k in ("支給", "送付", "素材", "写真", "ロゴ", "待ち")):
        cat_label = "素材待ち"
    elif any(k in t for k in ("未定", "確認後", "検討", "どうするか", "相談")):
        cat_label = "未決定事項"
    elif any(k in t for k in ("決定", "決まり", "合意", "進めます", "OK")):
        cat_label = "決定事項"
    else:
        cat_label = "クライアント要望"

    return {
        "board": updated,
        "spoken_message": f"承知しました。今の内容を{cat_label}として議事ボードに記録しました。続けてどうぞお話しください。",
        "next_focus": f"{cat_label}を記録済み（議論継続）",
        "model": "mock",
    }
