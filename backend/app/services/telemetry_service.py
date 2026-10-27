"""Telemetry queries, aggregation, energy integration and CSV export."""

from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import TelemetryReading

RANGE_DELTAS = {
    "15m": timedelta(minutes=15),
    "1h": timedelta(hours=1),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
}


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def query_points(
    db: Session,
    device_id: str,
    rng: str = "1h",
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = 4000,
) -> tuple[list[TelemetryReading], bool, float]:
    """Return (rows, downsampled, interval_s) for the requested window."""
    now = datetime.now(timezone.utc)
    if start is None or end is None:
        delta = RANGE_DELTAS.get(rng, timedelta(hours=1))
        end = end or now
        start = start or (end - delta)

    rows = db.execute(
        select(TelemetryReading)
        .where(
            TelemetryReading.device_id == device_id,
            TelemetryReading.ts >= start,
            TelemetryReading.ts <= end,
        )
        .order_by(TelemetryReading.ts.asc())
    ).scalars().all()

    downsampled = False
    if len(rows) > limit:
        step = len(rows) // limit + 1
        rows = rows[::step]
        downsampled = True

    interval = 30.0
    if len(rows) >= 2:
        interval = (_aware(rows[1].ts) - _aware(rows[0].ts)).total_seconds()
    return rows, downsampled, interval


def points_payload(rows: list[TelemetryReading]) -> list[dict]:
    out = []
    for r in rows:
        out.append(
            {
                "ts": _aware(r.ts).isoformat(),
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
        )
    return out


def latest_reading(db: Session, device_id: str) -> TelemetryReading | None:
    return db.execute(
        select(TelemetryReading)
        .where(TelemetryReading.device_id == device_id)
        .order_by(TelemetryReading.ts.desc())
        .limit(1)
    ).scalar_one_or_none()


def reading_at(db: Session, device_id: str, ts: datetime) -> TelemetryReading | None:
    return db.execute(
        select(TelemetryReading)
        .where(TelemetryReading.device_id == device_id, TelemetryReading.ts <= ts)
        .order_by(TelemetryReading.ts.desc())
        .limit(1)
    ).scalar_one_or_none()


def window_average(db: Session, device_id: str, start: datetime, end: datetime) -> dict | None:
    rows = db.execute(
        select(TelemetryReading).where(
            TelemetryReading.device_id == device_id,
            TelemetryReading.ts >= start,
            TelemetryReading.ts <= end,
            TelemetryReading.power_w.is_not(None),
        )
    ).scalars().all()
    if not rows:
        return None
    n = len(rows)
    irr = [r.irradiance_wm2 for r in rows if r.irradiance_wm2 is not None]
    return {
        "power_w": sum(r.power_w for r in rows if r.power_w is not None) / n,
        "voltage_v": sum(r.voltage_v for r in rows if r.voltage_v is not None and r.voltage_v is not None) / n,
        "current_a": sum(r.current_a for r in rows if r.current_a is not None) / n,
        "irradiance_wm2": (sum(irr) / len(irr)) if irr else None,
        "panel_temp_c": next((r.panel_temp_c for r in rows if r.panel_temp_c is not None), None),
        "samples": n,
    }


def energy_today_wh(db: Session, device_id: str) -> float | None:
    """Integrate sampled power since local midnight (estimate, not a meter reading)."""
    local_midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    rows = db.execute(
        select(TelemetryReading.ts, TelemetryReading.power_w)
        .where(
            TelemetryReading.device_id == device_id,
            TelemetryReading.ts >= local_midnight,
            TelemetryReading.power_w.is_not(None),
        )
        .order_by(TelemetryReading.ts.asc())
    ).all()
    if not rows:
        return None
    wh = 0.0
    for i in range(1, len(rows)):
        dt_h = (_aware(rows[i][0]) - _aware(rows[i - 1][0])).total_seconds() / 3600.0
        if dt_h <= 0 or dt_h > 1:  # guard against gaps being counted as production
            continue
        wh += ((rows[i][1] or 0) + (rows[i - 1][1] or 0)) / 2 * dt_h
    return round(wh, 1)


def energy_between(db: Session, device_id: str, start: datetime, end: datetime) -> float | None:
    rows = db.execute(
        select(TelemetryReading.ts, TelemetryReading.power_w).where(
            TelemetryReading.device_id == device_id,
            TelemetryReading.ts >= start,
            TelemetryReading.ts <= end,
            TelemetryReading.power_w.is_not(None),
        ).order_by(TelemetryReading.ts.asc())
    ).all()
    if len(rows) < 2:
        return None
    wh = 0.0
    for i in range(1, len(rows)):
        dt_h = (_aware(rows[i][0]) - _aware(rows[i - 1][0])).total_seconds() / 3600.0
        if dt_h <= 0 or dt_h > 1:
            continue
        wh += ((rows[i][1] or 0) + (rows[i - 1][1] or 0)) / 2 * dt_h
    return round(wh, 1)


def previous_period_power(db: Session, device_id: str, minutes: int = 60) -> float | None:
    now = datetime.now(timezone.utc)
    start = now - timedelta(minutes=minutes * 2)
    end = now - timedelta(minutes=minutes)
    avg = window_average(db, device_id, start, end)
    return round(avg["power_w"], 1) if avg else None


def telemetry_csv(rows: list[TelemetryReading]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        [
            "timestamp",
            "voltage_v",
            "current_a",
            "power_w",
            "panel_temp_c",
            "ambient_temp_c",
            "humidity_pct",
            "irradiance_wm2",
            "source",
            "quality",
        ]
    )
    for r in rows:
        writer.writerow(
            [
                _aware(r.ts).isoformat(),
                r.voltage_v,
                r.current_a,
                r.power_w,
                r.panel_temp_c,
                r.ambient_temp_c,
                r.humidity_pct,
                r.irradiance_wm2,
                r.source,
                r.quality,
            ]
        )
    return buf.getvalue()
