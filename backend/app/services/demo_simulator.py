"""Demo telemetry simulator.

Produces physically plausible but explicitly SIMULATED PV measurements so the
application remains fully usable with no hardware attached. Every reading
produced here is stored with source = "simulated" and is labelled as such in
the UI. It never represents a real measurement.
"""

from __future__ import annotations

import math
import random
import threading
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import CleaningJob, TelemetryReading

settings = get_settings()

# The demo site is fixed at ~23°N (India): drive the day/night cycle from the
# site's timezone so charts look the same no matter where the server runs.
SITE_TZ = timezone(timedelta(hours=5, minutes=30))


def _local_naive(dt: datetime) -> datetime:
    return dt.astimezone(SITE_TZ).replace(tzinfo=None)


def clear_sky_irradiance(ts: datetime) -> float:
    """Simple clear-sky proxy (site assumed at ~23°N, daylight 06:00-18:00 local)."""
    t = _local_naive(ts)
    hour = t.hour + t.minute / 60
    if hour < 5.6 or hour > 18.6:
        return 0.0
    x = min(1.0, max(0.0, (hour - 5.6) / 13.0))
    elevation = math.sin(math.pi * x)
    if elevation <= 0.0:
        return 0.0
    day_factor = 0.86 + 0.14 * math.sin(t.timetuple().tm_yday / 365.0 * 2 * math.pi)
    return max(0.0, 1050.0 * (elevation**1.15) * day_factor)


def ambient_temperature(ts: datetime) -> float:
    t = _local_naive(ts)
    hour = t.hour + t.minute / 60
    daily = 24.0 + 6.0 * math.sin((hour - 9.5) / 24.0 * 2 * math.pi)
    seasonal = 3.0 * math.sin(t.timetuple().tm_yday / 365.0 * 2 * math.pi)
    return round(daily + seasonal, 2)


def humidity(ts: datetime, ambient: float) -> float:
    base = 72.0 - (ambient - 20.0) * 2.1
    return round(max(15.0, min(95.0, base)), 1)


def soiling_loss_pct(db: Session, device_id: str, ts: datetime) -> float:
    """Accumulated soiling loss since the last completed cleaning cycle (%)."""
    last_clean = db.execute(
        select(CleaningJob.completed_at)
        .where(CleaningJob.device_id == device_id, CleaningJob.status == "completed")
        .order_by(CleaningJob.completed_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    ref = last_clean or (ts - timedelta(days=11))
    if last_clean is None:
        # oldest possible accumulation anchor for first boot
        ref = ts - timedelta(days=6)
    if ref.tzinfo is None:
        ref = ref.replace(tzinfo=timezone.utc)
    hours = max(0.0, (ts - ref).total_seconds() / 3600.0)
    # ~0.5 % per day of accumulation with a mild plateau, capped at 17 %
    loss = min(17.0, 0.6 + 0.5 * (hours / 24.0))
    if last_clean is None:
        loss = min(17.0, 4.0 + 0.5 * (hours / 24.0))
    jitter = random.Random(f"{device_id}-{ts.strftime('%Y%m%d%H')}").uniform(-0.5, 0.5)
    return round(max(0.0, loss + jitter), 2)


def cloud_factor(ts: datetime) -> float:
    """Slow + fast cloud modulation (1.0 = clear sky)."""
    seed = int(ts.timestamp() // 600)
    rng = random.Random(seed)
    slow = rng.uniform(0.55, 1.0) if rng.random() < 0.35 else 1.0
    t = ts.timestamp()
    fast = 0.92 + 0.08 * math.sin(t / 90.0) * math.sin(t / 33.0)
    return round(max(0.05, min(1.0, slow * fast)), 3)


def sample_reading(db: Session, device, ts: datetime) -> dict:
    """Compute one simulated measurement for *device* at *ts*."""
    rated_w = float(device.panel_rating_w)
    rated_vmp = 37.2 if rated_w <= 450 else 60.0
    rated_imp = round(rated_w / rated_vmp, 2)

    irr_clear = clear_sky_irradiance(ts)
    cloud = cloud_factor(ts) if irr_clear > 0 else 1.0
    irradiance = round(irr_clear * cloud, 1)

    loss = soiling_loss_pct(db, device.id, ts)
    ambient = ambient_temperature(ts)
    panel_temp = round(ambient + (irradiance / 1000.0) * 26.0, 1)

    # electrical model (illustrative, not a datasheet simulation)
    temp_derate = 1.0 - max(-0.10, min(0.05, (panel_temp - 25.0) * 0.0038))
    irradiance_factor = irradiance / 1000.0
    soiling_factor = 1.0 - (loss / 100.0)

    if irradiance <= 5.0:
        voltage, current = None, None
        power = None
    else:
        current = round(rated_imp * irradiance_factor * soiling_factor * temp_derate * random.uniform(0.985, 1.015), 3)
        voltage = round(
            rated_vmp * (0.86 + 0.14 * min(1.0, irradiance_factor)) * (1.0 - 0.0025 * (panel_temp - 25.0)),
            2,
        )
        power = round(voltage * current, 1)

    quality = "good"
    if power is not None and power > 0 and irradiance > 60 and (power / rated_w) < 0.05:
        quality = "stale"

    return {
        "ts": ts,
        "voltage_v": voltage,
        "current_a": current,
        "power_w": power,
        "panel_temp_c": panel_temp if irradiance > 5 else round(ambient, 1),
        "ambient_temp_c": ambient,
        "humidity_pct": humidity(ts, ambient),
        "irradiance_wm2": irradiance,
        "source": "simulated",
        "quality": quality,
    }


def seed_history(db: Session, device, days: int | None = None) -> int:
    """Backfill simulated history: 5-minute samples for N days, 1-minute for last 24 h."""
    days = days or max(settings.seed_history_days, 30)
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    rows: list[TelemetryReading] = []

    start_5m = now - timedelta(days=days)
    cursor = start_5m
    while cursor < now - timedelta(hours=24):
        data = sample_reading(db, device, cursor)
        # deliberate gaps so charts must handle missing data honestly
        if random.Random(int(cursor.timestamp())).random() > 0.012:
            rows.append(TelemetryReading(device_id=device.id, **data))
        cursor += timedelta(minutes=5)

    cursor = now - timedelta(hours=24)
    while cursor < now:
        data = sample_reading(db, device, cursor)
        if random.Random(int(cursor.timestamp())).random() > 0.02:
            rows.append(TelemetryReading(device_id=device.id, **data))
        cursor += timedelta(minutes=1)

    db.add_all(rows)
    db.commit()
    return len(rows)


class DemoSimulator:
    """Background tick generator for demo/hardware-free operation."""

    def __init__(self, session_factory) -> None:
        self._session_factory = session_factory
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if not settings.simulator_enabled or not settings.demo_mode:
            return
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="demo-simulator", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._thread = None

    def tick_once(self, device_id: str | None = None) -> None:
        """Insert exactly one simulated reading (used by tests and the loop)."""
        with self._lock:
            db: Session = self._session_factory()
            try:
                from ..models import Device

                devices = db.execute(
                    select(Device).where(Device.simulated.is_(True), Device.active.is_(True))
                ).scalars().all()
                if device_id:
                    devices = [d for d in devices if d.id == device_id]
                now = datetime.now(timezone.utc)
                for device in devices:
                    data = sample_reading(db, device, now)
                    db.add(TelemetryReading(device_id=device.id, **data))
                    device.last_heartbeat = now
                db.commit()
            finally:
                db.close()

    def _run(self) -> None:
        # seed history once per process
        try:
            self._seed_all()
        except Exception:  # pragma: no cover - defensive
            pass
        while not self._stop.wait(settings.simulator_tick_s):
            try:
                self.tick_once()
            except Exception:  # pragma: no cover - keep the loop alive
                continue

    def _seed_all(self) -> None:
        from ..models import Device

        db: Session = self._session_factory()
        try:
            devices = db.execute(select(Device).where(Device.simulated.is_(True))).scalars().all()
            for device in devices:
                existing = db.execute(
                    select(func.count()).select_from(TelemetryReading).where(TelemetryReading.device_id == device.id)
                ).scalar_one()
                if existing < 50:
                    seed_history(db, device)
        finally:
            db.close()


simulator = DemoSimulator(None)  # bound in app lifespan
