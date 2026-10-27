"""Application settings endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..schemas import SettingsResponse, SettingsUpdate
from ..security import CurrentUser, audit, require_admin
from ..services.events import log_event
from ..services.settings_service import load_settings, save_settings, settings_out, validate_settings

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("", response_model=SettingsResponse)
def get_settings_endpoint(_: CurrentUser, db: Session = Depends(get_db)):
    return SettingsResponse(settings=settings_out(db), warnings=validate_settings(load_settings(db)))


@router.put("", response_model=SettingsResponse)
def update_settings(
    payload: SettingsUpdate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    out = save_settings(db, payload, actor=admin.username)
    warnings = validate_settings(load_settings(db))
    changed = ", ".join(sorted(payload.model_dump(exclude_unset=True).keys())) or "none"
    log_event(
        db,
        "settings_changed",
        f"Settings updated by {admin.username}: {changed}",
        status="warning",
        actor=admin.username,
    )
    audit(db, admin.username, "settings_changed", "app", changed, request)
    return SettingsResponse(settings=out, warnings=warnings)
