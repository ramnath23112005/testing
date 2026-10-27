"""Operational event logging, alerting and notification helpers."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Alert, SystemEvent

EVENT_LABELS: dict[str, str] = {
    "image_captured": "Image captured",
    "prediction_generated": "AI prediction generated",
    "soiling_threshold_crossed": "Soiling threshold crossed",
    "cleaning_recommended": "Cleaning recommended",
    "cleaning_requested": "Cleaning requested",
    "cleaning_started": "Cleaning started",
    "cleaning_completed": "Cleaning completed",
    "cleaning_failed": "Cleaning failed",
    "cleaning_stopped": "Cleaning stopped",
    "sensor_offline": "Sensor offline",
    "device_disconnected": "Device disconnected",
    "device_connected": "Device connected",
    "safety_interlock": "Safety interlock triggered",
    "configuration_changed": "Configuration changed",
    "login": "User signed in",
    "auth_failed": "Sign-in failed",
    "permission_denied": "Permission denied",
    "settings_changed": "Settings changed",
    "device_created": "Device registered",
    "device_updated": "Device updated",
    "device_tested": "Device connection test",
    "model_status": "AI model status",
    "data_exported": "Data exported",
}


def log_event(
    db: Session,
    event_type: str,
    description: str,
    *,
    device_id: str | None = None,
    status: str = "info",
    actor: str = "system",
    reference: str | None = None,
    commit: bool = True,
) -> SystemEvent:
    event = SystemEvent(
        event_type=event_type,
        description=description[:512],
        device_id=device_id,
        status=status,
        actor=actor,
        reference=reference,
        ts=datetime.now(timezone.utc),
    )
    db.add(event)
    if commit:
        db.commit()
        db.refresh(event)
    return event


def create_alert(
    db: Session,
    severity: str,
    title: str,
    message: str,
    *,
    category: str = "system",
    device_id: str | None = None,
    dedupe: bool = True,
) -> Alert | None:
    if dedupe:
        existing = db.execute(
            select(Alert)
            .where(Alert.title == title, Alert.read.is_(False))
            .order_by(Alert.ts.desc())
            .limit(1)
        ).scalar_one_or_none()
        if existing is not None:
            return None
    alert = Alert(
        severity=severity,
        title=title,
        message=message[:512],
        category=category,
        device_id=device_id,
        ts=datetime.now(timezone.utc),
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return alert


def alert_counts(db: Session) -> tuple[int, int]:
    """Return (active alerts, unread alerts). Active = unread warning/critical."""
    rows = db.execute(select(Alert.severity).where(Alert.read.is_(False))).all()
    unread_count = len(rows)
    active = len([r for r in rows if r[0] in ("warning", "critical")])
    return active, unread_count
