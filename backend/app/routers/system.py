"""Health, system status and overview endpoints."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..schemas import HealthResponse, OverviewResponse, SystemStatus
from ..security import CurrentUser
from ..services.inference import classifier
from ..services.mqtt_adapter import mqtt_adapter
from ..services.settings_service import load_settings
from ..services.system_service import build_overview, build_system_status, resolve_device_id

router = APIRouter(prefix="/api", tags=["system"])
settings = get_settings()


@router.get("/health", response_model=HealthResponse)
def health(db: Session = Depends(get_db)):
    cfg = load_settings(db)
    db_name = "sqlite" if settings.database_url.startswith("sqlite") else "postgresql"
    return HealthResponse(
        status="ok",
        version=settings.app_version,
        demo_mode=bool(cfg.get("demo_mode", True)),
        database=db_name,
        model_available=classifier.available,
        mqtt_connected=mqtt_adapter.connected,
        time=datetime.now(timezone.utc),
    )


@router.get("/system/status", response_model=SystemStatus)
def system_status(_: CurrentUser, db: Session = Depends(get_db)):
    return SystemStatus(**build_system_status(db))


@router.get("/overview", response_model=OverviewResponse)
def overview(_: CurrentUser, device_id: str | None = Query(default=None), db: Session = Depends(get_db)):
    resolved = resolve_device_id(db, device_id)
    if resolved is None:
        raise HTTPException(status_code=404, detail="No device is registered yet.")
    try:
        return OverviewResponse(**build_overview(db, resolved))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
