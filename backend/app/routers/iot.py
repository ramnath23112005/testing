"""ESP32 firmware bridge.

The ESP32 (Arduino IDE sketch) talks to this router over plain HTTP. It is
authenticated with a shared ``X-Device-Key`` header instead of a user JWT
because the microcontroller has no login flow.

Routes (exactly the contract used by the firmware):

* ``POST /api/telemetry``        - measured voltage/current/power/light/temperature
* ``POST /api/device/status``    - heartbeat, sensor availability, firmware version
* ``GET  /api/ai/latest``        - newest stored visual classification for a device
* ``POST /api/ai/ingest``        - external CNN (laptop) pushes its classification
* ``GET  /api/cleaning/command`` - START/STOP/NONE, authorised by the dashboard
* ``POST /api/cleaning/result``  - cycle outcome with before/after power

All values are treated as *measured*. Nothing is invented here: missing sensors
are stored as NULL and flagged so the dashboard can render "unavailable".
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import AiPrediction, CleaningJob, Device, DeviceConnectionEvent, TelemetryReading
from ..services.events import create_alert, log_event
from ..services.settings_service import load_settings

router = APIRouter(prefix="/api", tags=["iot"])
settings = get_settings()

# Backend canonical labels <-> firmware/spec aliases
CLASS_ALIASES = {
    "light_dust": "lightly_dusty",
    "heavy_dust": "heavily_dusty",
    "lightly_dusty": "lightly_dusty",
    "heavily_dusty": "heavily_dusty",
    "bird_dropping": "bird_dropping",
    "clean": "clean",
}
ALIAS_OUT = {"lightly_dusty": "light_dust", "heavily_dusty": "heavy_dust"}
CLASSES = {"clean", "lightly_dusty", "heavily_dusty", "bird_dropping"}

# Firmware-side default motor speed for a dashboard-issued command
COMMAND_SPEED_PCT = 60


def require_device_key(x_device_key: str | None = Header(default=None, alias="X-Device-Key")) -> None:
    if not settings.iot_device_key or x_device_key != settings.iot_device_key:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Device-Key header.")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_ts(epoch: float | None, iso: str | None) -> datetime:
    if iso:
        try:
            parsed = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    if epoch:
        try:
            # Guard against a bogus clock (firmware without NTP) pre-2020 / far future.
            dt = datetime.fromtimestamp(float(epoch), tz=timezone.utc)
            if 1577836800 <= float(epoch) <= 4102444800:
                return dt
        except (ValueError, OSError, OverflowError):
            pass
    return _now()


def _device_id(raw: str | None) -> str:
    value = (raw or settings.iot_default_device_id).strip()
    return value[:64] or settings.iot_default_device_id


def _get_or_create_device(db: Session, device_id: str) -> Device:
    device = db.get(Device, device_id)
    if device is not None:
        return device
    device = Device(
        id=device_id,
        display_name=f"ESP32 solar array ({device_id})",
        location="Field installation",
        status="offline",
        panel_rating_w=100.0,
        camera_status="ok",
        electrical_sensor_status="unknown",
        controller_status="ok",
        firmware_version=None,
        simulated=False,
        active=True,
        has_irradiance_sensor=False,  # LDR is relative only, never W/m2
        has_climate_sensor=True,
        actuator_type="motor",
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    log_event(
        db,
        "device_registered",
        f"Device {device_id} auto-registered by firmware telemetry.",
        device_id=device_id,
        status="info",
        actor="esp32",
    )
    return device


def _mark_seen(db: Session, device: Device) -> None:
    was_online = device.status == "online"
    device.last_heartbeat = _now()
    device.status = "online"
    if not was_online:
        db.add(
            DeviceConnectionEvent(
                device_id=device.id, status="online", detail="ESP32 heartbeat received"
            )
        )
        log_event(
            db,
            "device_online",
            "ESP32 firmware connected and is reporting measured data.",
            device_id=device.id,
            status="success",
            actor="esp32",
        )
    db.commit()


# ----------------------------------------------------------------- schemas
class TelemetryIn(BaseModel):
    device_id: str | None = None
    timestamp: float | int | None = None
    ts_iso: str | None = None
    voltage: float | None = None
    current: float | None = None
    power: float | None = None
    light_level: float | None = None
    temperature: float | None = None
    motor_status: str | None = None
    wifi_status: str | None = None
    wifi_rssi: int | None = None
    firmware_version: str | None = None
    quality: Literal["good", "stale", "missing"] = "good"


class DeviceStatusIn(BaseModel):
    device_id: str | None = None
    online: bool = True
    firmware_version: str | None = None
    wifi_connected: bool | None = None
    wifi_rssi: int | None = None
    sensors: dict[str, bool] | None = None
    motor_status: str | None = None
    free_heap: int | None = None


class AiIngestIn(BaseModel):
    device_id: str | None = None
    predicted_class: str
    confidence: float
    probabilities: dict[str, float] | None = None
    recommendation: str | None = None
    detected_at: str | None = None
    demo: bool = False
    model_name: str = "external-cnn"
    model_version: str = "1.0.0"
    inference_ms: float = 0.0


class CleaningResultIn(BaseModel):
    job_id: str | None = None
    device_id: str | None = None
    status: Literal["completed", "stopped", "failed"] = "completed"
    started_at: str | None = None
    ended_at: str | None = None
    duration_s: float | None = None
    power_before: float | None = None
    power_after: float | None = None
    power_improvement: float | None = None
    outcome: str | None = None
    note: str | None = Field(default=None, max_length=255)


class AutoCleanIn(BaseModel):
    """Onboard decision engine asking the backend for authorisation.

    The device never bypasses the server: policy, interlocks and cooldown are
    still evaluated by ``cleaning_service.start`` before a job is created.
    """

    device_id: str | None = None
    reason: str = "Onboard decision engine"
    soiling_pct: float | None = None
    predicted_class: str | None = None
    confidence: float | None = None


# --------------------------------------------------------------- telemetry
@router.post("/telemetry")
def ingest_telemetry(
    payload: TelemetryIn,
    _: None = Depends(require_device_key),
    db: Session = Depends(get_db),
):
    device = _get_or_create_device(db, _device_id(payload.device_id))
    if payload.firmware_version:
        device.firmware_version = payload.firmware_version[:32]
    if payload.motor_status:
        device.controller_status = "ok"
    _mark_seen(db, device)

    reading = TelemetryReading(
        device_id=device.id,
        ts=_parse_ts(payload.timestamp, payload.ts_iso),
        voltage_v=payload.voltage,
        current_a=payload.current,
        power_w=payload.power,
        ambient_temp_c=payload.temperature,
        light_level=payload.light_level,
        source="measured",
        quality=payload.quality,
    )
    db.add(reading)
    db.commit()

    return {
        "ok": True,
        "device_id": device.id,
        "server_time": _now().isoformat(),
        "next_poll_s": 5,
    }


# ------------------------------------------------------------ device status
@router.post("/device/status")
def device_status(
    payload: DeviceStatusIn,
    _: None = Depends(require_device_key),
    db: Session = Depends(get_db),
):
    device = _get_or_create_device(db, _device_id(payload.device_id))
    if payload.firmware_version:
        device.firmware_version = payload.firmware_version[:32]
    sensors = payload.sensors or {}
    if "ina219" in sensors:
        device.electrical_sensor_status = "ok" if sensors["ina219"] else "fault"
    if payload.online:
        _mark_seen(db, device)
    else:
        device.status = "offline"
        db.commit()

    pending = db.execute(
        select(CleaningJob)
        .where(CleaningJob.device_id == device.id, CleaningJob.status == "queued")
        .order_by(CleaningJob.requested_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    return {
        "ok": True,
        "device_id": device.id,
        "sensor_status": device.electrical_sensor_status,
        "command_pending": pending is not None,
        "server_time": _now().isoformat(),
    }


# --------------------------------------------------------------------- AI
@router.get("/ai/latest")
def ai_latest(
    device_id: str | None = Query(default=None),
    _: None = Depends(require_device_key),
    db: Session = Depends(get_db),
):
    did = _device_id(device_id)
    row = db.execute(
        select(AiPrediction)
        .where(AiPrediction.device_id == did)
        .order_by(AiPrediction.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="No AI prediction stored for this device yet.")

    try:
        probs = json.loads(row.probabilities_json or "{}")
    except json.JSONDecodeError:
        probs = {}

    canonical = row.predicted_class if row.predicted_class in CLASSES else CLASS_ALIASES.get(
        row.predicted_class, "clean"
    )
    alias = ALIAS_OUT.get(canonical, canonical)
    flat = {
        "clean": float(probs.get("clean", 0.0)),
        "light_dust": float(probs.get("lightly_dusty", probs.get("light_dust", 0.0))),
        "heavy_dust": float(probs.get("heavily_dusty", probs.get("heavy_dust", 0.0))),
        "bird_dropping": float(probs.get("bird_dropping", 0.0)),
    }
    created = row.created_at if row.created_at.tzinfo else row.created_at.replace(tzinfo=timezone.utc)
    return {
        "device_id": did,
        "predicted_class": canonical,
        "predicted_class_alias": alias,
        "confidence": float(row.confidence),
        "probabilities": {**flat, "lightly_dusty": flat["light_dust"], "heavily_dusty": flat["heavy_dust"]},
        **flat,
        "recommendation": row.recommendation or "",
        "detected_at": created.isoformat(),
        "age_s": round((_now() - created).total_seconds(), 1),
        "demo": bool(row.demo),
        "model_name": row.model_name,
        "model_version": row.model_version,
    }


@router.post("/ai/ingest", status_code=201)
def ai_ingest(
    payload: AiIngestIn,
    _: None = Depends(require_device_key),
    db: Session = Depends(get_db),
):
    """Let the laptop CNN push its result so the ESP32 and dashboard share it."""
    canonical = CLASS_ALIASES.get(payload.predicted_class.strip().lower())
    if canonical is None:
        raise HTTPException(
            status_code=422,
            detail=f"predicted_class must be one of {sorted(CLASSES)} (aliases light_dust/heavy_dust accepted).",
        )
    confidence = max(0.0, min(1.0, float(payload.confidence)))
    probs = {
        CLASS_ALIASES.get(k.strip().lower(), k): max(0.0, min(1.0, float(v)))
        for k, v in (payload.probabilities or {}).items()
    }
    did = _device_id(payload.device_id)
    _get_or_create_device(db, did)

    row = AiPrediction(
        device_id=did,
        predicted_class=canonical,
        confidence=confidence,
        probabilities_json=json.dumps(probs),
        recommendation=(payload.recommendation or "")[:255],
        model_name=payload.model_name[:96],
        model_version=payload.model_version[:32],
        inference_ms=payload.inference_ms,
        source="demo" if payload.demo else "measured",
        demo=payload.demo,
        created_at=_parse_ts(None, payload.detected_at),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    log_event(
        db,
        "ai_prediction_received",
        f"External CNN classified {canonical} at {confidence:.0%} confidence.",
        device_id=did,
        status="info",
        actor="ai-bridge",
        reference=row.id,
    )
    return {
        "ok": True,
        "id": row.id,
        "device_id": did,
        "predicted_class": canonical,
        "confidence": confidence,
    }


# --------------------------------------------------------------- cleaning
@router.get("/cleaning/command")
def cleaning_command(
    device_id: str | None = Query(default=None),
    _: None = Depends(require_device_key),
    db: Session = Depends(get_db),
):
    did = _device_id(device_id)
    job = db.execute(
        select(CleaningJob)
        .where(CleaningJob.device_id == did, CleaningJob.status.in_(["queued", "running"]))
        .order_by(CleaningJob.requested_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    if job is None:
        return {"command": "NONE", "device_id": did}

    if job.status == "running" and job.error == "STOP_REQUESTED":
        return {"command": "STOP", "job_id": job.id, "device_id": did}

    if job.status == "queued":
        cfg = load_settings(db)
        job.status = "running"
        job.started_at = _now()
        job.acknowledged = True
        db.commit()
        log_event(
            db,
            "cleaning_dispatched",
            f"START command delivered to {did}; device acknowledged the request.",
            device_id=did,
            status="info",
            actor="esp32",
            reference=job.id,
        )
        return {
            "command": "START",
            "job_id": job.id,
            "device_id": did,
            "duration_s": float(cfg["max_cleaning_runtime_s"]),
            "speed_pct": COMMAND_SPEED_PCT,
            "reason": job.reason,
        }

    return {"command": "NONE", "job_id": job.id, "device_id": did}


@router.post("/cleaning/auto-request")
def cleaning_auto(
    payload: AutoCleanIn,
    _: None = Depends(require_device_key),
    db: Session = Depends(get_db),
):
    """Firmware-initiated cleaning request (AUTO mode).

    Runs through the same policy/interlock/cooldown checks as the dashboard
    button, so ``monitoring_only`` installations stay read-only no matter what
    the device decides locally.
    """
    from ..services.cleaning_service import cleaning_service

    did = _device_id(payload.device_id)
    _get_or_create_device(db, did)

    bits = [payload.reason.strip() or "Onboard decision engine"]
    if payload.predicted_class:
        bits.append(f"AI: {payload.predicted_class}")
    if payload.confidence is not None:
        bits.append(f"{payload.confidence:.0%}")
    if payload.soiling_pct is not None:
        bits.append(f"measured loss {payload.soiling_pct:.0f}%")
    reason = " - ".join(bits)[:255]

    try:
        job, detail = cleaning_service.start(
            db, did, actor="esp32-auto", reason=reason, trigger="automatic"
        )
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None

    return {
        "ok": True,
        "job_id": job.get("id"),
        "status": job.get("status"),
        "detail": detail,
    }


@router.post("/cleaning/result")
def cleaning_result(
    payload: CleaningResultIn,
    _: None = Depends(require_device_key),
    db: Session = Depends(get_db),
):
    did = _device_id(payload.device_id)
    job: CleaningJob | None = None
    if payload.job_id:
        job = db.get(CleaningJob, payload.job_id)
        if job is not None and job.device_id != did:
            raise HTTPException(status_code=409, detail="Job does not belong to this device.")
    if job is None:
        job = db.execute(
            select(CleaningJob)
            .where(CleaningJob.device_id == did, CleaningJob.status.in_(["queued", "running"]))
            .order_by(CleaningJob.requested_at.desc())
            .limit(1)
        ).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="No matching cleaning job for this device.")

    job.status = payload.status
    job.completed_at = _parse_ts(None, payload.ended_at)
    if payload.duration_s is not None:
        job.duration_s = max(0.0, float(payload.duration_s))
    job.power_before_w = payload.power_before
    job.power_after_w = payload.power_after
    if (
        payload.power_before is not None
        and payload.power_after is not None
        and payload.power_before > 0
    ):
        job.delta_pct = round((payload.power_after - payload.power_before) / payload.power_before * 100.0, 2)
    note_parts = [p for p in (payload.outcome, payload.note) if p]
    if note_parts:
        job.measurement_note = " - ".join(note_parts)[:255]
    job.error = None if payload.status == "completed" else (payload.note or payload.outcome or payload.status)[:255]
    job.acknowledged = True
    db.commit()

    log_event(
        db,
        f"cleaning_{payload.status}",
        f"Device reported cycle {job.id[:8]} {payload.status}"
        + (f" ({payload.duration_s:.0f}s)" if payload.duration_s is not None else "")
        + (f"; power {payload.power_before:.1f} W -> {payload.power_after:.1f} W"
           if payload.power_before is not None and payload.power_after is not None
           else ""),
        device_id=did,
        status="success" if payload.status == "completed" else "warning",
        actor="esp32",
        reference=job.id,
    )
    create_alert(
        db,
        "info" if payload.status == "completed" else "warning",
        f"Cleaning {payload.status} (hardware)",
        f"ESP32 finished cycle {job.id[:8]}: {payload.outcome or payload.status}.",
        category="cleaning",
        device_id=did,
    )
    return {
        "ok": True,
        "job_id": job.id,
        "status": job.status,
        "delta_pct": job.delta_pct,
    }
