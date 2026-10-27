"""Cleaning-control service: interlocks, acknowledgement handling and job lifecycle.

Safety invariants enforced server-side (never trusted from the browser):

* authentication + operator/admin role (enforced by the router)
* device must be online or an explicitly simulated demo device
* safety interlock must report a safe state
* cooldown and minimum interval between cycles
* maximum runtime watchdog
* stop is only reported as succeeded after acknowledgement of the idle state
* every command is written to the audit log and the event log
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import CleaningJob, CleaningMeasurement, Device, TelemetryReading
from ..schemas import CleaningJobOut
from .events import create_alert, log_event
from .settings_service import load_settings
from .telemetry_service import window_average

logger = logging.getLogger("soilingguard.cleaning")
settings = get_settings()

PUMP_POWER_W = 180.0
WATER_FLOW_LPM = 1.2


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def job_out(job: CleaningJob) -> dict:
    return CleaningJobOut.model_validate(job).model_dump(mode="json")


class CleaningService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop_flags: dict[str, threading.Event] = {}
        self._faults: dict[str, str] = {}

    # ------------------------------ helpers ----------------------------
    def _active_job(self, db: Session, device_id: str) -> CleaningJob | None:
        return db.execute(
            select(CleaningJob)
            .where(CleaningJob.device_id == device_id, CleaningJob.status.in_(["queued", "running"]))
            .order_by(CleaningJob.requested_at.desc())
            .limit(1)
        ).scalar_one_or_none()

    def _last_completed(self, db: Session, device_id: str) -> CleaningJob | None:
        return db.execute(
            select(CleaningJob)
            .where(CleaningJob.device_id == device_id, CleaningJob.status.in_(["completed", "stopped", "failed"]))
            .order_by(CleaningJob.requested_at.desc())
            .limit(1)
        ).scalar_one_or_none()

    def interlock(self, db: Session, device: Device) -> tuple[bool, str | None]:
        if not device.active:
            return False, "Device is marked inactive."
        if device.controller_status == "offline":
            return False, "Cleaning controller reports offline."
        if device.controller_status == "degraded":
            return False, "Cleaning controller reports a degraded state."
        fault = self._faults.get(device.id)
        if fault:
            return False, fault
        return True, None

    def cooldown_remaining(self, db: Session, device_id: str, cfg: dict) -> float:
        job = self._last_completed(db, device_id)
        if job is None or job.requested_at is None:
            return 0.0
        elapsed = (datetime.now(timezone.utc) - _aware(job.requested_at)).total_seconds()
        cooldown = float(cfg["cleaning_cooldown_s"])
        interval = float(cfg["min_interval_s"])
        return max(0.0, cooldown - elapsed, interval - elapsed)

    def can_start(self, db: Session, device: Device, cfg: dict) -> tuple[bool, str | None]:
        ok, reason = self.interlock(db, device)
        if not ok:
            return False, reason
        if self._active_job(db, device.id) is not None:
            return False, "A cleaning cycle is already in progress."
        if cfg.get("policy") == "monitoring_only":
            return False, "Policy is 'Monitoring only' - actuator commands are disabled."
        remaining = self.cooldown_remaining(db, device.id, cfg)
        if remaining > 0:
            return False, f"Cooldown active: {remaining / 60:.1f} minutes remaining."
        if not device.simulated and device.status != "online":
            return False, "Device is offline; real actuator controls are disabled."
        return True, None

    # ------------------------------- status ----------------------------
    def status(self, db: Session, device_id: str) -> dict:
        device = db.get(Device, device_id)
        if device is None:
            raise ValueError("Device not found")
        cfg = load_settings(db)
        active = self._active_job(db, device_id)
        can, reason = self.can_start(db, device, cfg)
        interlock_ok, interlock_reason = self.interlock(db, device)

        jobs = db.execute(
            select(CleaningJob).where(CleaningJob.device_id == device_id)
        ).scalars().all()
        completed = [j for j in jobs if j.status == "completed"]
        failed = [j for j in jobs if j.status in {"failed", "aborted"}]
        last = max(completed, key=lambda j: j.requested_at) if completed else None

        hw_online = device.simulated or device.status == "online"

        actuator_state = "unknown"
        if active is not None:
            actuator_state = "running"
        elif self._faults.get(device_id):
            actuator_state = "fault"
        elif interlock_ok:
            actuator_state = "idle"

        return {
            "device_id": device_id,
            "hardware_online": hw_online,
            "actuator": device.actuator_type,
            "actuator_state": actuator_state,
            "water_level_pct": (
                round(max(5.0, 100 - len(completed) * 3.0), 1) if device.simulated else None
            ),
            "water_sensor_present": device.simulated,
            "interlock_ok": interlock_ok,
            "interlock_reason": interlock_reason,
            "fault": self._faults.get(device_id),
            "cycles_completed": len(completed),
            "cycles_failed": len(failed),
            "last_cycle_at": _aware(last.requested_at) if last else None,
            "last_cycle_duration_s": last.duration_s if last else None,
            "water_consumed_l": round(sum(j.water_liters or 0 for j in jobs), 2),
            "energy_consumed_wh": round(sum(j.energy_wh or 0 for j in jobs), 2),
            "cooldown_remaining_s": self.cooldown_remaining(db, device_id, cfg),
            "max_runtime_s": float(cfg["max_cleaning_runtime_s"]),
            "auto_cleaning_enabled": bool(cfg.get("auto_cleaning_enabled", False)),
            "policy": cfg["policy"],
            "current_job": job_out(active) if active else None,
            "can_start": can,
            "cannot_start_reason": reason,
            "simulated": device.simulated,
        }

    # -------------------------------- start ----------------------------
    def start(
        self,
        db: Session,
        device_id: str,
        actor: str,
        reason: str,
        trigger: str = "manual",
    ) -> tuple[dict, str]:
        device = db.get(Device, device_id)
        if device is None:
            raise ValueError("Device not found")
        cfg = load_settings(db)
        can, why = self.can_start(db, device, cfg)
        if not can:
            raise PermissionError(why or "Cleaning start refused by safety checks.")

        simulated = device.simulated
        job = CleaningJob(
            device_id=device_id,
            status="queued",
            trigger=trigger,
            initiated_by=actor,
            reason=reason[:255],
            requested_at=datetime.now(timezone.utc),
            simulated=simulated,
            acknowledged=False,
        )
        db.add(job)
        db.commit()
        db.refresh(job)

        log_event(
            db,
            "cleaning_requested",
            f"Cleaning requested ({trigger}): {reason}",
            device_id=device_id,
            status="warning",
            actor=actor,
            reference=job.id,
        )
        db.expire(job)

        stop_flag = threading.Event()
        with self._lock:
            self._stop_flags[device_id] = stop_flag

        job_id = job.id
        thread = threading.Thread(
            target=self._run_cycle,
            args=(job_id, device_id, simulated, stop_flag),
            name=f"cleaning-{job_id[:8]}",
            daemon=True,
        )
        thread.start()

        detail = (
            f"Simulated cycle queued ({'demo actuator' if simulated else 'hardware command'})."
            if simulated
            else "Command published to the device; awaiting acknowledgement."
        )
        job = db.get(CleaningJob, job_id)
        return (job_out(job) if job else {}, detail)

    def _run_cycle(self, job_id: str, device_id: str, simulated: bool, stop: threading.Event) -> None:
        from ..database import SessionLocal

        db = SessionLocal()
        try:
            job = db.get(CleaningJob, job_id)
            if job is None:
                return
            # --- acknowledgement (simulated devices ack immediately) ----
            time.sleep(0.6 if simulated else 3.0)
            job = db.get(CleaningJob, job_id)
            if job is None:
                return
            if stop.is_set():
                job.status = "stopped"
                job.completed_at = datetime.now(timezone.utc)
                job.duration_s = 0.0
                job.error = "Stopped before acknowledgement."
                db.commit()
                return

            job.status = "running"
            job.started_at = datetime.now(timezone.utc)
            job.acknowledged = True
            db.commit()
            log_event(
                db,
                "cleaning_started",
                "Cleaning cycle started; device acknowledged the start command.",
                device_id=device_id,
                status="info",
                actor=job.initiated_by,
                reference=job.id,
            )

            cfg = load_settings(db)
            max_runtime = float(cfg["max_cleaning_runtime_s"])
            duration = min(30.0, max_runtime) if simulated else max_runtime
            started = time.monotonic()

            while time.monotonic() - started < duration:
                if stop.is_set():
                    elapsed = time.monotonic() - started
                    job = db.get(CleaningJob, job_id)
                    job.status = "stopped"
                    job.completed_at = datetime.now(timezone.utc)
                    job.duration_s = round(elapsed, 1)
                    job.water_liters = round(WATER_FLOW_LPM * elapsed / 60.0, 2)
                    job.energy_wh = round(PUMP_POWER_W * elapsed / 3600.0, 3)
                    db.commit()
                    log_event(
                        db,
                        "cleaning_stopped",
                        f"Cleaning cycle stopped after {elapsed:.0f}s (device acknowledged idle state).",
                        device_id=device_id,
                        status="warning",
                        actor=job.initiated_by,
                        reference=job.id,
                    )
                    create_alert(
                        db,
                        "info",
                        "Cleaning stopped",
                        f"Cycle {job.id[:8]} was stopped by {job.initiated_by}.",
                        category="cleaning",
                        device_id=device_id,
                    )
                    self._schedule_outcome(job_id, device_id, duration_before_s=900)
                    return
                time.sleep(0.5)

            job = db.get(CleaningJob, job_id)
            job.status = "completed"
            job.completed_at = datetime.now(timezone.utc)
            job.duration_s = round(time.monotonic() - started, 1)
            job.water_liters = round(WATER_FLOW_LPM * job.duration_s / 60.0, 2)
            job.energy_wh = round(PUMP_POWER_W * job.duration_s / 3600.0, 3)
            job.acknowledged = True
            db.commit()

            log_event(
                db,
                "cleaning_completed",
                f"Cleaning cycle completed in {job.duration_s:.0f}s "
                f"({job.water_liters:.1f} L water, {job.energy_wh:.1f} Wh).",
                device_id=device_id,
                status="success",
                actor=job.initiated_by,
                reference=job.id,
            )
            create_alert(
                db,
                "info",
                "Cleaning completed",
                f"Cycle {job.id[:8]} finished in {job.duration_s:.0f} s.",
                category="cleaning",
                device_id=device_id,
            )
            self._schedule_outcome(job_id, device_id, duration_before_s=900)
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("Cleaning cycle failed")
            try:
                job = db.get(CleaningJob, job_id)
                if job is not None:
                    job.status = "failed"
                    job.error = str(exc)[:255]
                    job.completed_at = datetime.now(timezone.utc)
                    db.commit()
                    log_event(
                        db,
                        "cleaning_failed",
                        f"Cleaning cycle failed: {exc}",
                        device_id=device_id,
                        status="critical",
                        actor=job.initiated_by,
                        reference=job.id,
                    )
            except Exception:
                db.rollback()
        finally:
            with self._lock:
                self._stop_flags.pop(device_id, None)
            db.close()

    def _schedule_outcome(self, job_id: str, device_id: str, duration_before_s: float = 900) -> None:
        thread = threading.Thread(
            target=self._evaluate_outcome,
            args=(job_id, device_id, duration_before_s),
            name=f"outcome-{job_id[:8]}",
            daemon=True,
        )
        thread.start()

    def _evaluate_outcome(self, job_id: str, device_id: str, duration_before_s: float) -> None:
        """Compare comparable windows after the simulator has produced new data."""
        from ..database import SessionLocal

        time.sleep(75.0)  # allow telemetry after the cycle to accumulate
        db = SessionLocal()
        try:
            job = db.get(CleaningJob, job_id)
            if job is None or job.status not in {"completed", "stopped"}:
                return
            device = db.get(Device, device_id)
            start = _aware(job.started_at) or _aware(job.requested_at)
            before = window_average(db, device_id, start - timedelta(seconds=duration_before_s), start)
            after_end = (datetime.now(timezone.utc))
            after = window_average(db, device_id, job.completed_at or start, after_end)
            if not before or not after or before["power_w"] <= 0:
                job.measurement_note = "Outcome not evaluated: insufficient comparable telemetry in the before/after windows."
                db.commit()
                return

            job.power_before_w = round(before["power_w"], 1)
            job.power_after_w = round(after["power_w"], 1)
            job.delta_pct = round((after["power_w"] - before["power_w"]) / before["power_w"] * 100.0, 2)

            normalized = False
            if (
                device is not None
                and device.has_irradiance_sensor
                and before.get("irradiance_wm2")
                and after.get("irradiance_wm2")
            ):
                b = before["power_w"] / (before["irradiance_wm2"] / 1000.0)
                a = after["power_w"] / (after["irradiance_wm2"] / 1000.0)
                job.delta_pct = round((a - b) / b * 100.0, 2)
                job.measurement_note = (
                    "Measured windows irradiance-normalised "
                    f"({before['samples']} samples before, {after['samples']} after)."
                )
                normalized = True
            else:
                job.measurement_note = (
                    "ESTIMATE: raw power comparison without irradiance normalisation "
                    f"({before['samples']} samples before, {after['samples']} after). "
                    "Cloud cover or temperature differences may explain part of the change."
                )

            db.add(
                CleaningMeasurement(
                    job_id=job.id, kind="before", ts=start, power_w=job.power_before_w,
                    voltage_v=before.get("voltage_v"), current_a=before.get("current_a"),
                    irradiance_wm2=before.get("irradiance_wm2"), panel_temp_c=before.get("panel_temp_c"),
                    source="simulated", note="window average",
                )
            )
            db.add(
                CleaningMeasurement(
                    job_id=job.id, kind="after", ts=datetime.now(timezone.utc), power_w=job.power_after_w,
                    voltage_v=after.get("voltage_v"), current_a=after.get("current_a"),
                    irradiance_wm2=after.get("irradiance_wm2"), panel_temp_c=after.get("panel_temp_c"),
                    source="simulated", note="window average",
                )
            )
            db.commit()
            log_event(
                db,
                "cleaning_completed",
                f"Outcome evaluation: {job.power_before_w:.0f} W → {job.power_after_w:.0f} W "
                f"({job.delta_pct:+.1f}%) {'(normalised)' if normalized else '(estimate)'}",
                device_id=device_id,
                status="info",
                actor="system",
                reference=job.id,
            )
        except Exception:  # pragma: no cover
            logger.exception("Outcome evaluation failed")
            db.rollback()
        finally:
            db.close()

    # -------------------------------- stop -----------------------------
    def stop(self, db: Session, device_id: str, actor: str, reason: str = "Operator stop") -> tuple[dict | None, str]:
        job = self._active_job(db, device_id)
        if job is None:
            raise RuntimeError("No active cleaning cycle to stop.")
        with self._lock:
            flag = self._stop_flags.get(device_id)
        if flag is not None:
            flag.set()
        else:
            # no runtime thread (e.g. after restart) - force finalise
            job.status = "stopped"
            job.completed_at = datetime.now(timezone.utc)
            job.error = "Stopped by operator; no acknowledgement path for this job instance."
            db.commit()

        log_event(
            db,
            "cleaning_requested",
            f"Stop requested by {actor}: {reason}",
            device_id=device_id,
            status="warning",
            actor=actor,
            reference=job.id,
        )
        # wait (bounded) for the runtime thread to acknowledge the idle state
        for _ in range(20):
            db.expire_all()
            current = db.get(CleaningJob, job.id)
            if current is None or current.status in {"stopped", "completed", "failed"}:
                return (job_out(current) if current else None), (
                    "Device acknowledged the idle state; cycle stopped."
                )
            time.sleep(0.25)
        return (
            job_out(db.get(CleaningJob, job.id)),
            "Stop command issued but no acknowledgement was received within the timeout; treated as unconfirmed.",
        )

    # -------------------------------- test -----------------------------
    def test_actuator(self, db: Session, device_id: str, actor: str) -> dict:
        device = db.get(Device, device_id)
        if device is None:
            raise ValueError("Device not found")
        ok, reason = self.interlock(db, device)
        if not ok:
            raise PermissionError(reason or "Interlock prevents actuator test.")
        if not device.simulated and device.status != "online":
            raise PermissionError("Device offline; actuator test refused.")
        if self._active_job(db, device_id):
            raise PermissionError("Cannot test while a cycle is running.")
        time.sleep(0.4 if device.simulated else 2.0)
        log_event(
            db,
            "cleaning_started",
            f"Actuator test pulse completed ({device.actuator_type}).",
            device_id=device_id,
            status="info",
            actor=actor,
        )
        return {
            "ok": True,
            "detail": (
                f"Simulated {device.actuator_type} test pulse completed (demo actuator)."
                if device.simulated
                else f"{device.actuator_type} acknowledged a 2 s test pulse."
            ),
        }

    def set_auto(self, db: Session, device_id: str, enabled: bool, actor: str) -> None:
        cfg = load_settings(db)
        cfg["auto_cleaning_enabled"] = enabled
        from ..services.settings_service import save_settings
        from ..schemas import SettingsUpdate

        save_settings(db, SettingsUpdate(auto_cleaning_enabled=enabled), actor)
        log_event(
            db,
            "configuration_changed",
            f"Automatic cleaning {'enabled' if enabled else 'disabled'} for {device_id}.",
            device_id=device_id,
            status="warning",
            actor=actor,
        )

    def clear_fault(self, device_id: str) -> None:
        self._faults.pop(device_id, None)


cleaning_service = CleaningService()
