"""Device CRUD, connection tests, history and telemetry."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import CleaningJob, Device, DeviceConnectionEvent, PvModule, User
from ..schemas import (
    ConnectionEventOut,
    DeviceCreate,
    DeviceOut,
    DeviceUpdate,
    TelemetryResponse,
)
from ..security import CurrentUser, audit, require_admin, require_operator
from ..services.events import log_event
from ..services.settings_service import load_settings
from ..services.system_service import device_effective_status, latest_ts_for
from ..services.telemetry_service import query_points

router = APIRouter(prefix="/api/devices", tags=["devices"])
settings = get_settings()


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _operating_mode(db: Session, device: Device, status: str) -> str:
    cfg = load_settings(db)
    active = db.execute(
        select(CleaningJob)
        .where(CleaningJob.device_id == device.id, CleaningJob.status.in_(["queued", "running"]))
        .limit(1)
    ).scalar_one_or_none()
    if active is not None:
        return "CLEANING IN PROGRESS"
    if not device.active:
        return "HARDWARE OFFLINE"
    if device.simulated and bool(cfg.get("demo_mode", True)):
        return "DEMO MODE"
    return "HARDWARE CONNECTED" if status == "online" else "HARDWARE OFFLINE"


def device_out(db: Session, device: Device) -> dict:
    latest = latest_ts_for(db, device.id)
    status = device_effective_status(device, latest)
    if not device.active:
        status = "inactive"
    modules = db.execute(select(PvModule).where(PvModule.device_id == device.id)).scalars().all()
    return DeviceOut(
        id=device.id,
        display_name=device.display_name,
        location=device.location,
        status=status,
        panel_rating_w=device.panel_rating_w,
        camera_status=device.camera_status,
        electrical_sensor_status=device.electrical_sensor_status,
        controller_status=device.controller_status,
        firmware_version=device.firmware_version,
        telemetry_topic=device.telemetry_topic,
        command_topic=device.command_topic,
        last_heartbeat=_aware(device.last_heartbeat),
        operating_mode=_operating_mode(db, device, status),
        simulated=device.simulated,
        created_at=device.created_at,
        active=device.active,
        has_irradiance_sensor=device.has_irradiance_sensor,
        has_climate_sensor=device.has_climate_sensor,
        actuator_type=device.actuator_type,
        modules=modules,
    ).model_dump(mode="json")


def _get_device(db: Session, device_id: str) -> Device:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail=f"Device '{device_id}' not found.")
    return device


@router.get("", response_model=list[DeviceOut])
def list_devices(_: CurrentUser, db: Session = Depends(get_db)):
    devices = db.execute(select(Device).order_by(Device.created_at.asc())).scalars().all()
    return [device_out(db, d) for d in devices]


@router.post("", response_model=DeviceOut, status_code=201)
def create_device(
    payload: DeviceCreate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if db.get(Device, payload.id) is not None:
        raise HTTPException(status_code=409, detail=f"Device '{payload.id}' already exists.")
    device = Device(
        id=payload.id,
        display_name=payload.display_name,
        location=payload.location,
        panel_rating_w=payload.panel_rating_w,
        telemetry_topic=payload.telemetry_topic or f"{settings.mqtt_topic_prefix}/{payload.id}/telemetry",
        command_topic=payload.command_topic or f"{settings.mqtt_topic_prefix}/{payload.id}/command",
        actuator_type=payload.actuator_type,
        has_irradiance_sensor=payload.has_irradiance_sensor,
        has_climate_sensor=payload.has_climate_sensor,
        simulated=payload.simulated,
        status="online" if payload.simulated else "unknown",
        camera_status="ok" if payload.simulated else "unknown",
        electrical_sensor_status="ok" if payload.simulated else "unknown",
        controller_status="ok" if payload.simulated else "unknown",
        firmware_version="sim-1.0" if payload.simulated else None,
        last_heartbeat=datetime.now(timezone.utc),
    )
    device.modules.append(PvModule(device_id=payload.id, name="Module A", rated_power_w=payload.panel_rating_w))
    db.add(device)
    db.add(DeviceConnectionEvent(device_id=payload.id, status="online", detail="Device registered"))
    db.commit()
    db.refresh(device)
    log_event(db, "device_created", f"Device '{payload.id}' registered ({'simulated' if payload.simulated else 'hardware'}).", device_id=payload.id, actor=admin.username)
    audit(db, admin.username, "device_created", payload.id, payload.display_name, request)
    return device_out(db, device)


@router.get("/{device_id}", response_model=DeviceOut)
def get_device(device_id: str, _: CurrentUser, db: Session = Depends(get_db)):
    return device_out(db, _get_device(db, device_id))


@router.put("/{device_id}", response_model=DeviceOut)
def update_device(
    device_id: str,
    payload: DeviceUpdate,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    device = _get_device(db, device_id)
    changed = payload.model_dump(exclude_unset=True, exclude={None})
    for key, value in changed.items():
        setattr(device, key, value)
    if changed.get("active") is False:
        device.status = "inactive"
    elif changed.get("active") is True and device.status == "inactive":
        device.status = "unknown"
    db.add(DeviceConnectionEvent(device_id=device.id, status=device.status, detail="Device configuration updated"))
    db.commit()
    log_event(db, "device_updated", f"Device '{device.id}' updated: {', '.join(changed) or 'no fields'}.", device_id=device.id, actor=admin.username)
    audit(db, admin.username, "device_updated", device.id, ", ".join(changed), request)
    return device_out(db, device)


@router.post("/{device_id}/test")
def test_device(
    device_id: str,
    request: Request,
    operator: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    device = _get_device(db, device_id)
    if not device.active:
        return {"ok": False, "detail": "Device is marked inactive."}
    if device.simulated:
        device.last_heartbeat = datetime.now(timezone.utc)
        device.status = "online"
        db.add(DeviceConnectionEvent(device_id=device.id, status="online", detail="Simulated connection test passed"))
        db.commit()
        detail = "Simulated device responded to the connection test (demo actuator, no hardware involved)."
        ok = True
    else:
        from ..services.mqtt_adapter import mqtt_adapter

        ok = mqtt_adapter.connected
        detail = (
            "MQTT broker acknowledged the connectivity probe."
            if ok
            else "No broker path is configured for this hardware device (MQTT disconnected). Connection test failed."
        )
        db.add(DeviceConnectionEvent(device_id=device.id, status="online" if ok else "offline", detail=detail))
        device.status = "online" if ok else "offline"
        db.commit()
    log_event(
        db,
        "device_tested",
        f"Connection test for '{device.id}': {'OK' if ok else 'FAILED'} - {detail}",
        device_id=device.id,
        status="info" if ok else "warning",
        actor=operator.username,
    )
    audit(db, operator.username, "device_tested", device.id, detail, request, success=ok)
    return {"ok": ok, "detail": detail}


@router.get("/{device_id}/connection-history", response_model=list[ConnectionEventOut])
def connection_history(device_id: str, _: CurrentUser, db: Session = Depends(get_db)):
    _get_device(db, device_id)
    rows = db.execute(
        select(DeviceConnectionEvent)
        .where(DeviceConnectionEvent.device_id == device_id)
        .order_by(DeviceConnectionEvent.ts.desc())
        .limit(100)
    ).scalars().all()
    return rows


@router.get("/{device_id}/telemetry", response_model=TelemetryResponse)
def device_telemetry(
    device_id: str,
    _: CurrentUser,
    range: str = Query(default="1h", alias="range"),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None, alias="to"),
    limit: int = Query(default=4000, ge=10, le=20_000),
    db: Session = Depends(get_db),
):
    device = _get_device(db, device_id)
    start = end = None
    if from_:
        try:
            start = datetime.fromisoformat(from_.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid 'from' timestamp: {exc}") from None
    if to:
        try:
            end = datetime.fromisoformat(to.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid 'to' timestamp: {exc}") from None
    rows, downsampled, interval = query_points(db, device_id, rng=range, start=start, end=end, limit=limit)
    source = rows[-1].source if rows else ("simulated" if device.simulated else "simulated")
    return TelemetryResponse(
        device_id=device_id,
        range=range if not (start and end) else "custom",
        source=source,
        simulated=device.simulated,
        count=len(rows),
        interval_s=interval,
        downsampled=downsampled,
        points=[
            {
                "ts": r.ts,
                "voltage_v": r.voltage_v,
                "current_a": r.current_a,
                "power_w": r.power_w,
                "panel_temp_c": r.panel_temp_c,
                "ambient_temp_c": r.ambient_temp_c,
                "humidity_pct": r.humidity_pct,
                "irradiance_wm2": r.irradiance_wm2,
                "source": r.source,
                "quality": r.quality,
            }
            for r in rows
        ],
    )
