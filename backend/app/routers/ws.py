"""Live telemetry WebSocket (authenticated).

The browser connects to /ws/telemetry?device_id=<id>&token=<jwt>. The server
streams persisted readings as they are produced by the simulator or by real
hardware ingestion; nothing is fabricated in this socket.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from ..config import get_settings
from ..database import SessionLocal
from ..models import Device, TelemetryReading, User
from ..security import decode_token

logger = logging.getLogger("soilingguard.ws")
router = APIRouter()
settings = get_settings()


def _point(row: TelemetryReading) -> dict:
    return {
        "ts": row.ts.isoformat(),
        "voltage_v": row.voltage_v,
        "current_a": row.current_a,
        "power_w": row.power_w,
        "panel_temp_c": row.panel_temp_c,
        "ambient_temp_c": row.ambient_temp_c,
        "humidity_pct": row.humidity_pct,
        "irradiance_wm2": row.irradiance_wm2,
        "source": row.source,
        "quality": row.quality,
    }


def _authenticate(token: str | None) -> bool:
    if not token:
        return False
    try:
        payload = decode_token(token)
    except Exception:
        return False
    db = SessionLocal()
    try:
        user = db.get(User, int(payload.get("sub", 0)))
        return user is not None and user.is_active
    finally:
        db.close()


def _latest(device_id: str, last_ts: str | None) -> dict | None:
    db = SessionLocal()
    try:
        row = db.execute(
            select(TelemetryReading)
            .where(TelemetryReading.device_id == device_id)
            .order_by(TelemetryReading.ts.desc())
            .limit(1)
        ).scalar_one_or_none()
        if row is None:
            return None
        ts = row.ts.isoformat()
        if ts == last_ts:
            return None
        return {"ts": ts, "point": _point(row)}
    finally:
        db.close()


def _primary_device() -> str | None:
    db = SessionLocal()
    try:
        dev = db.execute(
            select(Device).where(Device.active.is_(True)).order_by(Device.created_at.asc()).limit(1)
        ).scalar_one_or_none()
        return dev.id if dev else None
    finally:
        db.close()


@router.websocket("/ws/telemetry")
async def telemetry_socket(ws: WebSocket, device_id: str | None = Query(default=None), token: str | None = Query(default=None)):
    if not _authenticate(token):
        await ws.close(code=4401, reason="Missing or invalid token")
        return
    await ws.accept()

    target = device_id or _primary_device()
    if target is None:
        await ws.send_json({"type": "info", "message": "No device registered."})
        target = ""
    else:
        db = SessionLocal()
        try:
            exists = db.get(Device, target) is not None
        finally:
            db.close()
        if not exists:
            await ws.send_json({"type": "error", "message": f"Device '{target}' not found."})
            target = ""

    last_ts: str | None = None
    try:
        while True:
            if target:
                msg = await asyncio.to_thread(_latest, target, last_ts)
                if msg:
                    last_ts = msg["ts"]
                    await ws.send_json({"type": "telemetry", "device_id": target, "point": msg["point"]})
            await asyncio.sleep(2.0)
    except WebSocketDisconnect:
        return
    except Exception:  # pragma: no cover
        logger.exception("telemetry socket failed")
        try:
            await ws.close(code=1011)
        except Exception:
            pass
