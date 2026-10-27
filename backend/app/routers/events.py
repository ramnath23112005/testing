"""Operational event log endpoints."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import SystemEvent
from ..schemas import EventListResponse, EventOut
from ..security import CurrentUser
from ..services.events import EVENT_LABELS

router = APIRouter(prefix="/api/events", tags=["events"])


def _parse(value: str | None, default: datetime | None) -> datetime | None:
    if not value:
        return default
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid timestamp: {value}") from None


def _out(event: SystemEvent) -> dict:
    return EventOut(
        id=event.id,
        ts=event.ts,
        event_type=event.event_type,
        event_label=EVENT_LABELS.get(event.event_type, event.event_type.replace("_", " ").title()),
        device_id=event.device_id,
        description=event.description,
        status=event.status,
        actor=event.actor,
        reference=event.reference,
    ).model_dump(mode="json")


@router.get("", response_model=EventListResponse)
def list_events(
    _: CurrentUser,
    search: str | None = Query(default=None, max_length=120),
    event_type: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    db: Session = Depends(get_db),
):
    start = _parse(from_, None)
    end = _parse(to, None)
    q = select(SystemEvent)
    if search:
        q = q.where(SystemEvent.description.ilike(f"%{search}%"))
    if event_type:
        q = q.where(SystemEvent.event_type == event_type)
    if start:
        q = q.where(SystemEvent.ts >= start)
    if end:
        q = q.where(SystemEvent.ts <= end)

    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(
        q.order_by(SystemEvent.ts.desc()).offset((page - 1) * page_size).limit(page_size)
    ).scalars().all()

    types = db.execute(select(SystemEvent.event_type).distinct()).scalars().all()
    return EventListResponse(
        items=[_out(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
        event_types=sorted(types),
    )


@router.get("/{event_id}", response_model=EventOut)
def get_event(event_id: str, _: CurrentUser, db: Session = Depends(get_db)):
    event = db.get(SystemEvent, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found.")
    return _out(event)
