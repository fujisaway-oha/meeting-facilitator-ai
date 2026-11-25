from __future__ import annotations

import hashlib
import hmac
import time
from fastapi import Cookie, HTTPException, status

from backend import config

COOKIE_NAME = "mf_session"
SESSION_TTL_SEC = 60 * 60 * 24  # 24時間


def verify_passcode(candidate: str) -> bool:
    """タイミング攻撃を防ぐ定数時間比較でパスコードを検証する。"""
    expected = config.APP_PASSCODE.encode("utf-8")
    given = (candidate or "").encode("utf-8")
    return hmac.compare_digest(expected, given)


def create_session_token() -> str:
    expires = str(int(time.time()) + SESSION_TTL_SEC)
    sig = hmac.new(
        config.APP_SECRET_KEY.encode("utf-8"),
        expires.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{expires}.{sig}"


def is_valid_session_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    expires_str, given_sig = token.split(".", 1)
    if not expires_str.isdigit():
        return False
    if int(expires_str) < int(time.time()):
        return False
    expected_sig = hmac.new(
        config.APP_SECRET_KEY.encode("utf-8"),
        expires_str.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected_sig, given_sig)


def require_auth(mf_session: str | None = Cookie(default=None)) -> None:
    if not is_valid_session_token(mf_session):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="認証が必要です。パスコードを入力してログインしてください。",
        )
