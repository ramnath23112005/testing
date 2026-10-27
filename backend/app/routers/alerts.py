"""Alert endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Alert, User
from ..schemas import AlertListResponse, AlertOut
from ..security import CurrentUser

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


def _payload(db: Session) -> AlertListResponse:
    rows = db.execute(select(Alert).order_by(Alert.ts.desc()).limit(200)).scalars().all()
    return AlertListResponse(
        items=[AlertOut.model_validate(a).model_dump(mode="json") for a in rows],
        unread=sum(1 for a in rows if not a.read),
    )


@router.get("", response_model=AlertListResponse)
def list_alerts(_: CurrentUser, db: Session = Depends(get_db)):
    return _payload(db)


@router.post("/{alert_id}/read", response_model=AlertListResponse)
def mark_read(alert_id: str, _: CurrentUser, db: Session = Depends(get_db)):
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found.")
    alert.read = True
    db.commit()
    return _payload(db)


@router.post("/read-all", response_model=AlertListResponse)
def mark_all_read(_: CurrentUser, db: Session = Depends(get_db)):
    rows = db.execute(select(Alert).where(Alert.read.is_(False))).scalars().all()
    for alert in rows:
        alert.read = True
    db.commit()
    return _payload(db)
