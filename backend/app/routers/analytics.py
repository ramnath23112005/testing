"""Analytics summary endpoint."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..security import CurrentUser
from ..services.analytics_service import build_summary
from ..services.system_service import resolve_device_id

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


def _parse(value: str | None, default: datetime) -> datetime:
    if not value:
        return default
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid timestamp: {value}") from None


@router.get("/summary")
def summary(
    _: CurrentUser,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    device_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    start = _parse(from_, now - timedelta(days=7))
    end = _parse(to, now)
    if start > end:
        raise HTTPException(status_code=400, detail="'from' must be earlier than 'to'.")
    resolved = resolve_device_id(db, device_id)
    return build_summary(db, start, end, resolved)
