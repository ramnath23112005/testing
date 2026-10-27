"""CSV export endpoints (all rows come from the database, nothing synthetic)."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from ..database import get_db
from ..security import CurrentUser
from ..services.analytics_service import events_csv, summary_csv
from ..services.events import log_event
from ..services.settings_service import load_settings
from ..services.system_service import resolve_device_id
from ..services.telemetry_service import query_points, telemetry_csv

router = APIRouter(prefix="/api/export", tags=["export"])


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid timestamp: {value}") from None


def _csv_response(content: str, filename: str) -> Response:
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/telemetry")
def export_telemetry(
    _: CurrentUser,
    device_id: str | None = Query(default=None),
    range: str = Query(default="24h"),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    resolved = resolve_device_id(db, device_id)
    if resolved is None:
        raise HTTPException(status_code=404, detail="No device is registered yet.")
    rows, _, _ = query_points(db, resolved, rng=range, start=_parse(from_), end=_parse(to), limit=50_000)
    log_event(db, "data_exported", f"Telemetry export ({len(rows)} rows, range={range}).", device_id=resolved, actor="api")
    return _csv_response(telemetry_csv(rows), f"telemetry-{resolved}-{range}.csv")


@router.get("/analytics")
def export_analytics(
    _: CurrentUser,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    device_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    from datetime import timedelta

    now = datetime.now(timezone.utc)
    start = _parse(from_) or (now - timedelta(days=7))
    end = _parse(to) or now
    resolved = resolve_device_id(db, device_id)
    from ..services.analytics_service import build_summary

    summary = build_summary(db, start, end, resolved)
    log_event(db, "data_exported", f"Analytics export ({start.date()} → {end.date()}).", actor="api")
    return _csv_response(summary_csv(summary), f"analytics-{start.date()}_{end.date()}.csv")


@router.get("/events")
def export_events(
    _: CurrentUser,
    search: str | None = Query(default=None),
    event_type: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    content = events_csv(db, _parse(from_), _parse(to), search, event_type)
    log_event(db, "data_exported", f"Events export (type={event_type or 'all'}).", actor="api")
    return _csv_response(content, "events.csv")


@router.get("/settings")
def export_settings(_: CurrentUser, db: Session = Depends(get_db)):
    """Effective configuration as JSON (safe: no secrets are stored here)."""
    import json

    cfg = load_settings(db)
    log_event(db, "data_exported", "Settings export.", actor="api")
    return Response(
        content=json.dumps(cfg, indent=2, default=str),
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="settings.json"'},
    )
