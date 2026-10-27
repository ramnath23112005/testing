"""Cleaning control endpoints (interlock + role protected)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import CleaningJob, User
from ..schemas import (
    ActuatorTestRequest,
    AutoCleaningRequest,
    CleaningHistoryResponse,
    CleaningJobOut,
    CleaningRequest,
    CleaningStopRequest,
    CleaningStatusOut,
)
from ..security import CurrentUser, audit, rate_limit, require_operator
from ..services.cleaning_service import cleaning_service
from ..services.system_service import resolve_device_id

router = APIRouter(prefix="/api/cleaning", tags=["cleaning"])
settings = get_settings()


def _resolve(db: Session, device_id: str | None) -> str:
    resolved = resolve_device_id(db, device_id)
    if resolved is None:
        raise HTTPException(status_code=404, detail="No device is registered yet.")
    return resolved


def _conflict(exc: Exception) -> HTTPException:
    """Safety refusals are surfaced as 409 with an explanation (never as success)."""
    return HTTPException(status_code=409, detail=str(exc))


@router.get("/status", response_model=CleaningStatusOut)
def status(_: CurrentUser, device_id: str | None = Query(default=None), db: Session = Depends(get_db)):
    did = _resolve(db, device_id)
    return cleaning_service.status(db, did)


@router.post("/request")
def request_cleaning(
    payload: CleaningRequest,
    request: Request,
    operator: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    rate_limit(request, "cleaning", settings.cleaning_rate_limit_per_minute, 60)
    if not payload.confirm:
        raise HTTPException(
            status_code=400,
            detail="Explicit confirmation is required before a cleaning cycle can be started.",
        )
    did = _resolve(db, payload.device_id)
    try:
        job, detail = cleaning_service.start(
            db, did, actor=operator.username, reason=payload.reason, trigger=payload.trigger
        )
    except PermissionError as exc:
        audit(db, operator.username, "cleaning_requested", did, f"refused: {exc}", request, success=False)
        raise _conflict(exc) from None
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    audit(db, operator.username, "cleaning_requested", did, payload.reason, request)
    return {"job": job, "detail": detail}


@router.post("/stop")
def stop_cleaning(
    payload: CleaningStopRequest,
    request: Request,
    operator: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    if not payload.confirm:
        raise HTTPException(status_code=400, detail="Explicit confirmation is required to stop a cycle.")
    did = _resolve(db, payload.device_id)
    try:
        job, detail = cleaning_service.stop(db, did, actor=operator.username, reason=payload.reason)
    except RuntimeError as exc:
        raise _conflict(exc) from None
    audit(db, operator.username, "cleaning_stopped", did, detail, request)
    return {"job": job, "detail": detail}


@router.post("/test")
def test_actuator(
    payload: ActuatorTestRequest,
    request: Request,
    operator: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    rate_limit(request, "cleaning", settings.cleaning_rate_limit_per_minute, 60)
    did = _resolve(db, payload.device_id)
    try:
        result = cleaning_service.test_actuator(db, did, actor=operator.username)
    except PermissionError as exc:
        audit(db, operator.username, "actuator_test", did, f"refused: {exc}", request, success=False)
        raise _conflict(exc) from None
    audit(db, operator.username, "actuator_test", did, result["detail"], request)
    return result


@router.post("/auto", response_model=CleaningStatusOut)
def toggle_auto(
    payload: AutoCleaningRequest,
    request: Request,
    operator: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    did = _resolve(db, payload.device_id)
    cleaning_service.set_auto(db, did, payload.enabled, actor=operator.username)
    audit(db, operator.username, "auto_cleaning", did, f"enabled={payload.enabled}", request)
    return cleaning_service.status(db, did)


@router.get("/history", response_model=CleaningHistoryResponse)
def history(
    _: CurrentUser,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    device_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    q = select(CleaningJob)
    if device_id:
        q = q.where(CleaningJob.device_id == device_id)
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(
        q.order_by(CleaningJob.requested_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).scalars().all()
    return CleaningHistoryResponse(
        items=[CleaningJobOut.model_validate(r).model_dump(mode="json") for r in rows],
        total=total,
        simulated=all(r.simulated for r in rows) if rows else True,
    )
