"""Authentication endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import User
from ..schemas import AuthResponse, LoginRequest, UserOut
from ..security import audit, create_access_token, get_current_user, rate_limit, verify_password
from ..services.events import log_event

router = APIRouter(prefix="/api/auth", tags=["auth"])
settings = get_settings()


@router.post("/login", response_model=AuthResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit(request, "login", settings.login_rate_limit_per_minute, 60)
    user = db.execute(select(User).where(User.username == payload.username)).scalar_one_or_none()
    ok = user is not None and user.is_active and verify_password(payload.password, user.password_hash)
    if not ok:
        audit(db, payload.username, "login", "", "invalid credentials", request, success=False)
        log_event(
            db,
            "auth_failed",
            f"Failed sign-in attempt for '{payload.username}'.",
            status="warning",
            actor=payload.username,
        )
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = create_access_token(user)
    audit(db, user.username, "login", f"user:{user.id}", "signed in", request)
    log_event(db, "login", f"{user.full_name or user.username} signed in ({user.role}).", actor=user.username)
    return AuthResponse(
        access_token=token,
        user=UserOut(id=user.id, username=user.username, full_name=user.full_name, role=user.role),
    )


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return UserOut(id=user.id, username=user.username, full_name=user.full_name, role=user.role)
