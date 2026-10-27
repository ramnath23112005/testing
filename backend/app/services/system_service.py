"""System status, operating mode and overview composition."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    AiPrediction,
    Alert,
    CleaningJob,
    Device,
    PanelImage,
    SystemEvent,
    TelemetryReading,
)
from ..schemas import AlertOut
from .events import alert_counts
from .inference import CLASS_LABELS, classifier
from .settings_service import load_settings
from .telemetry_service import energy_between, energy_today_wh, latest_reading, previous_period_power

MODE_OFFLINE = "HARDWARE OFFLINE"
MODE_CONNECTED = "HARDWARE CONNECTED"
MODE_DEMO = "DEMO MODE"
MODE_NO_MODEL = "AI MODEL UNAVAILABLE"
MODE_CLEANING = "CLEANING IN PROGRESS"
MODE_FAULT = "FAULT DETECTED"

FRESH_S = 120.0


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def device_effective_status(device: Device, latest_ts: datetime | None) -> str:
    if not device.active:
        return "inactive"
    now = datetime.now(timezone.utc)
    hb = _aware(device.last_heartbeat)
    latest = _aware(latest_ts)
    freshest = max([t for t in (hb, latest) if t is not None], default=None)
    if freshest and (now - freshest).total_seconds() <= FRESH_S:
        return "online"
    if freshest and (now - freshest).total_seconds() <= 3600:
        return "unknown"
    return "offline"


def primary_device(db: Session) -> Device | None:
    return db.execute(
        select(Device).where(Device.active.is_(True)).order_by(Device.created_at.asc()).limit(1)
    ).scalar_one_or_none()


def resolve_device_id(db: Session, device_id: str | None) -> str | None:
    if device_id:
        return device_id
    dev = primary_device(db)
    return dev.id if dev else None


def latest_ts_for(db: Session, device_id: str) -> datetime | None:
    ts = db.execute(
        select(TelemetryReading.ts)
        .where(TelemetryReading.device_id == device_id)
        .order_by(TelemetryReading.ts.desc())
        .limit(1)
    ).scalar_one_or_none()
    return _aware(ts)


def build_system_status(db: Session) -> dict:
    cfg = load_settings(db)
    demo_mode = bool(cfg.get("demo_mode", True))
    info = classifier.info
    device = primary_device(db)
    device_id = device.id if device else None

    latest = latest_reading(db, device_id) if device_id else None
    last_telemetry = _aware(latest.ts) if latest else None
    last_image = _aware(
        db.execute(select(PanelImage.captured_at).order_by(PanelImage.captured_at.desc()).limit(1)).scalar_one_or_none()
    )
    last_inference = _aware(
        db.execute(select(AiPrediction.created_at).order_by(AiPrediction.created_at.desc()).limit(1)).scalar_one_or_none()
    )
    last_cleaning = _aware(
        db.execute(
            select(CleaningJob.completed_at)
            .where(CleaningJob.completed_at.is_not(None))
            .order_by(CleaningJob.completed_at.desc())
            .limit(1)
        ).scalar_one_or_none()
    )

    running = db.execute(
        select(CleaningJob).where(CleaningJob.status.in_(["queued", "running"])).limit(1)
    ).scalar_one_or_none()
    recent_failed = db.execute(
        select(CleaningJob)
        .where(
            CleaningJob.status == "failed",
            CleaningJob.completed_at >= datetime.now(timezone.utc) - timedelta(minutes=10),
        )
        .limit(1)
    ).scalar_one_or_none()

    active_alerts, unread = alert_counts(db)
    critical_unread = db.execute(
        select(Alert).where(Alert.read.is_(False), Alert.severity == "critical").limit(1)
    ).scalar_one_or_none()

    devices = db.execute(select(Device).where(Device.active.is_(True))).scalars().all()
    statuses = {d.id: device_effective_status(d, latest_ts_for(db, d.id)) for d in devices}
    hardware_connected = any(
        not d.simulated and statuses[d.id] == "online" for d in devices
    )
    hardware_online = any(s == "online" for s in statuses.values())

    fault_active = recent_failed is not None or critical_unread is not None
    cleaning_in_progress = running is not None

    if fault_active:
        mode = MODE_FAULT
    elif cleaning_in_progress:
        mode = MODE_CLEANING
    elif demo_mode:
        mode = MODE_DEMO
    elif not info["available"]:
        mode = MODE_NO_MODEL
    elif hardware_connected:
        mode = MODE_CONNECTED
    else:
        mode = MODE_OFFLINE

    source = latest.source if latest else "simulated"

    return {
        "operating_mode": mode,
        "demo_mode": demo_mode,
        "hardware_connected": hardware_connected,
        "hardware_online": hardware_online,
        "cleaning_in_progress": cleaning_in_progress,
        "fault_active": fault_active,
        "active_alerts": active_alerts,
        "unread_alerts": unread,
        "last_telemetry_at": last_telemetry,
        "last_image_at": last_image,
        "last_inference_at": last_inference,
        "last_cleaning_at": last_cleaning,
        "model": info,
        "primary_device_id": device_id,
        "telemetry_source": source,
    }


SEVERITY_BY_CLASS = {
    "clean": 2.0,
    "lightly_dusty": 8.0,
    "heavily_dusty": 18.0,
    "bird_dropping": 14.0,
}


def _severity_estimate(db: Session, device_id: str, prediction: AiPrediction | None, loss: float | None) -> float | None:
    if prediction is None:
        return None
    base = SEVERITY_BY_CLASS.get(prediction.predicted_class, 5.0)
    visual = base * min(1.0, prediction.confidence)
    if loss is not None and loss >= 0:
        # blend visual estimate with normalised electrical loss (explicitly an estimate)
        return round(min(35.0, 0.5 * visual + 0.5 * min(loss, 35.0)), 1)
    return round(min(35.0, visual), 1)


def build_overview(db: Session, device_id: str | None) -> dict:
    status = build_system_status(db)
    cfg = load_settings(db)
    did = device_id or status["primary_device_id"]
    if did is None:
        raise ValueError("No device registered")

    device = db.get(Device, did)
    latest = latest_reading(db, did)
    now = datetime.now(timezone.utc)

    prediction = db.execute(
        select(AiPrediction)
        .where(AiPrediction.device_id == did)
        .order_by(AiPrediction.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    image = db.get(PanelImage, prediction.image_id) if prediction and prediction.image_id else None

    energy = energy_today_wh(db, did)
    y_start = now.astimezone().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
    y_end = y_start + timedelta(hours=now.hour, minutes=now.minute)
    prev_energy = energy_between(db, did, y_start, y_end)
    prev_power = previous_period_power(db, did, minutes=60)

    # normalised power loss for severity (best-effort; None when not computable)
    loss = None
    if latest and latest.power_w and latest.power_w > 0 and latest.irradiance_wm2 and device:
        ref = float(device.panel_rating_w) * (latest.irradiance_wm2 / 1000.0)
        if ref > 0:
            loss = round(max(0.0, (1 - latest.power_w / ref)) * 100, 1)

    last_clean = db.execute(
        select(CleaningJob.completed_at)
        .where(CleaningJob.device_id == did, CleaningJob.status == "completed")
        .order_by(CleaningJob.completed_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    source = latest.source if latest else "simulated"
    simulated = source in {"simulated", "demo", "estimated"}

    alerts = db.execute(
        select(Alert).where(Alert.read.is_(False)).order_by(Alert.ts.desc()).limit(10)
    ).scalars().all()

    metrics = {
        "device_id": did,
        "source": source,
        "simulated": simulated,
        "voltage_v": latest.voltage_v if latest else None,
        "current_a": latest.current_a if latest else None,
        "power_w": latest.power_w if latest else None,
        "energy_today_wh": energy,
        "prev_power_w": prev_power,
        "prev_energy_wh": prev_energy,
        "soiling_class": prediction.predicted_class if prediction else None,
        "soiling_label": CLASS_LABELS.get(prediction.predicted_class, prediction.predicted_class) if prediction else None,
        "soiling_confidence": prediction.confidence if prediction else None,
        "soiling_severity_pct": _severity_estimate(db, did, prediction, loss),
        "last_cleaning_at": _aware(last_clean),
        "operating_mode": status["operating_mode"],
        "quality_note": (
            None
            if latest and latest.quality == "good"
            else "Latest reading flagged or missing - treat values with caution."
        ),
    }

    condition = {
        "image_id": image.id if image else None,
        "image_url": image.url if image else None,
        "predicted_class": prediction.predicted_class if prediction else None,
        "predicted_label": CLASS_LABELS.get(prediction.predicted_class, prediction.predicted_class) if prediction else None,
        "confidence": prediction.confidence if prediction else None,
        "captured_at": _aware(image.captured_at) if image else None,
        "model_version": prediction.model_version if prediction else None,
        "recommendation": prediction.recommendation if prediction else None,
        "source": ("demo" if prediction.demo else prediction.source) if prediction else None,
    }

    activity = {
        "last_sensor_at": _aware(latest.ts) if latest else None,
        "last_image_at": _aware(
            db.execute(select(PanelImage.captured_at).order_by(PanelImage.captured_at.desc()).limit(1)).scalar_one_or_none()
        ),
        "last_inference_at": _aware(
            db.execute(select(AiPrediction.created_at).order_by(AiPrediction.created_at.desc()).limit(1)).scalar_one_or_none()
        ),
        "last_cleaning_at": _aware(last_clean),
        "operating_mode": status["operating_mode"],
        "active_alerts": [AlertOut.model_validate(a).model_dump() for a in alerts],
    }

    job = db.execute(
        select(CleaningJob)
        .where(CleaningJob.device_id == did, CleaningJob.status == "completed")
        .order_by(CleaningJob.completed_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    if job and job.power_before_w and job.power_after_w:
        before = job.power_before_w
        after = job.power_after_w
        delta = job.delta_pct
        recovered = None
        if delta is not None and job.duration_s:
            recovered = round(before * (delta / 100.0) * (job.duration_s / 3600.0), 2)
        recovery = {
            "available": True,
            "note": job.measurement_note or "Comparative window around the cleaning cycle.",
            "power_before_w": round(before, 1),
            "power_after_w": round(after, 1),
            "delta_pct": round(delta, 2) if delta is not None else None,
            "cleaning_energy_wh": job.energy_wh,
            "recovered_energy_wh": recovered,
            "measured": "measured" in (job.measurement_note or "").lower(),
        }
    else:
        recovery = {
            "available": False,
            "note": "No completed cleaning cycle with comparable before/after measurements yet. Energy recovery is only reported once both windows exist; it remains an estimate unless irradiance normalisation was possible.",
            "power_before_w": None,
            "power_after_w": None,
            "delta_pct": None,
            "cleaning_energy_wh": None,
            "recovered_energy_wh": None,
            "measured": False,
        }

    # expose the computed normalised loss for reference
    metrics["normalized_power_loss_pct"] = loss

    return {"metrics": metrics, "condition": condition, "activity": activity, "recovery": recovery}
