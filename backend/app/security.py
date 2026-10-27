"""Authentication, authorization, rate limiting and audit helpers."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Annotated, Callable

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .config import get_settings
from .database import get_db
from .models import AuditLog, User

settings = get_settings()
bearer_scheme = HTTPBearer(auto_error=False)

PBKDF2_ITERATIONS = 240_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _scheme, iterations, salt, digest = stored.split("$")
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt.encode("ascii"), int(iterations)
        )
        return hmac.compare_digest(dk.hex(), digest)
    except (ValueError, TypeError):
        return False


def create_access_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role,
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_expire_minutes),
    }
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.secret_key, algorithms=["HS256"])


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = decode_token(credentials.credentials)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired") from None
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid credentials token") from None

    user = db.get(User, int(payload["sub"]))
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or disabled")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_roles(*roles: str) -> Callable:
    def checker(user: CurrentUser) -> User:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{user.role}' is not permitted to perform this action (requires {', '.join(roles)})",
            )
        return user

    return checker


# Role policy ---------------------------------------------------------
# viewer : read-only
# operator : read + cleaning commands + image confirmation
# admin  : everything incl. device CRUD, settings, users
require_operator = require_roles("operator", "admin")
require_admin = require_roles("admin")


# --------------------------- rate limiting ----------------------------
_buckets: dict[str, deque[float]] = defaultdict(deque)


def rate_limit(request: Request, key: str, limit: int, window_s: int = 60) -> None:
    """Fixed-window sliding rate limiter (per client IP + key)."""
    now = time.monotonic()
    ip = request.client.host if request.client else "unknown"
    bucket_key = f"{key}:{ip}"
    q = _buckets[bucket_key]
    while q and now - q[0] > window_s:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(status_code=429, detail=f"Rate limit exceeded for {key}. Try again shortly.")
    q.append(now)


# ------------------------------- audit --------------------------------
def audit(
    db: Session,
    actor: str,
    action: str,
    target: str = "",
    detail: str = "",
    request: Request | None = None,
    success: bool = True,
) -> None:
    """Append an immutable audit record (normal users cannot modify or delete)."""
    db.add(
        AuditLog(
            actor=actor,
            action=action,
            target=target,
            detail=detail[:1024],
            ip_address=request.client.host if request and request.client else None,
            success=success,
        )
    )
    db.commit()


def dumps(obj: object) -> str:
    return json.dumps(obj, default=str)
