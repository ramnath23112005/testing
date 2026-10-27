"""Sensor-fusion decision endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import CleaningDecision, User
from ..schemas import DecisionOut
from ..security import CurrentUser, require_operator
from ..services import decision_engine
from ..services.system_service import resolve_device_id

router = APIRouter(prefix="/api/decision", tags=["decision"])


def _resolve(db: Session, device_id: str | None) -> str:
    resolved = resolve_device_id(db, device_id)
    if resolved is None:
        raise HTTPException(status_code=404, detail="No device is registered yet.")
    return resolved


@router.get("/latest")
def latest_decision(_: CurrentUser, device_id: str | None = Query(default=None), db: Session = Depends(get_db)):
    did = _resolve(db, device_id)
    row = db.execute(
        select(CleaningDecision)
        .where(CleaningDecision.device_id == did)
        .order_by(CleaningDecision.ts.desc())
        .limit(1)
    ).scalar_one_or_none()
    return decision_engine.row_out(row) if row else None


@router.post("/evaluate", response_model=DecisionOut)
def evaluate_decision(
    _: CurrentUser,
    device_id: str | None = Query(default=None),
    operator: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    did = _resolve(db, device_id)
    result = decision_engine.evaluate(db, did, persist=True)
    return decision_engine.to_outcome(result)
