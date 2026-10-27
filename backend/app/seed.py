"""Idempotent database seeding: accounts, demo device, demo imagery and labels."""

from __future__ import annotations

import io
import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .config import get_settings
from .models import (
    AiPrediction,
    Alert,
    CleaningJob,
    Device,
    GroundTruthLabel,
    PanelImage,
    PvModule,
    SystemEvent,
    User,
)
from .security import hash_password
from .services.events import create_alert, log_event
from .services.image_gen import generate_panel_image
from .services.inference import demo_heuristic, sha256_of

logger = logging.getLogger("soilingguard.seed")
settings = get_settings()

# (days_ago, hour, variant, true_class)
DEMO_IMAGES: list[tuple[int, int, str, str]] = [
    (6, 10, "clean", "clean"),
    (5, 14, "light", "lightly_dusty"),
    (4, 11, "heavy", "heavily_dusty"),
    (3, 9, "bird", "bird_dropping"),
    (2, 15, "light", "lightly_dusty"),
    (1, 10, "heavy", "heavily_dusty"),
    (1, 16, "clean", "clean"),
    (0, 9, "clean", "clean"),
]

# Demo accounts from earlier builds - removed so Ramnath is the only user.
LEGACY_SEED_USERNAMES = ("admin", "operator", "viewer")


def _media_root():
    from pathlib import Path

    root = Path(settings.media_dir)
    (root / "demo").mkdir(parents=True, exist_ok=True)
    return root


def seed_users(db: Session) -> None:
    accounts = [
        (settings.seed_ramnath_username, settings.seed_ramnath_password, "Ramnath", "admin"),
    ]
    for username, password, full_name, role in accounts:
        existing = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
        if existing is None:
            db.add(
                User(
                    username=username,
                    password_hash=hash_password(password),
                    full_name=full_name,
                    role=role,
                    is_active=True,
                )
            )
    # Single-account deployment: drop the demo accounts from earlier builds.
    db.execute(delete(User).where(User.username.in_(LEGACY_SEED_USERNAMES)))
    db.commit()


def seed_device(db: Session) -> Device:
    device = db.get(Device, "PV-DEMO-01")
    if device is None:
        device = Device(
            id="PV-DEMO-01",
            display_name="Roof Array A (simulated)",
            location="Building roof - south facing",
            status="online",
            panel_rating_w=400.0,
            camera_status="ok",
            electrical_sensor_status="ok",
            controller_status="ok",
            firmware_version="sim-1.0",
            telemetry_topic=f"{settings.mqtt_topic_prefix}/PV-DEMO-01/telemetry",
            command_topic=f"{settings.mqtt_topic_prefix}/PV-DEMO-01/command",
            simulated=True,
            active=True,
            has_irradiance_sensor=True,
            has_climate_sensor=True,
            actuator_type="pump",
            last_heartbeat=datetime.now(timezone.utc),
        )
        device.modules.append(
            PvModule(device_id="PV-DEMO-01", name="Module A", rated_power_w=400.0, vmp_v=37.2, imp_a=10.8, technology="mono-PERC")
        )
        device.modules.append(
            PvModule(device_id="PV-DEMO-01", name="Module B", rated_power_w=400.0, vmp_v=37.2, imp_a=10.8, technology="mono-PERC")
        )
        db.add(device)
        db.commit()
        db.refresh(device)
    return device


def seed_demo_imagery(db: Session, device: Device) -> int:
    """Create clearly labelled demo images, demo predictions and ground-truth labels."""
    existing = db.execute(select(func.count()).select_from(PanelImage)).scalar_one()
    if existing:
        return 0
    root = _media_root()
    now = datetime.now(timezone.utc)
    created = 0
    for days_ago, hour, variant, true_class in DEMO_IMAGES:
        captured = (now - timedelta(days=days_ago)).replace(hour=hour, minute=5, second=0, microsecond=0)
        image = generate_panel_image(
            loss_pct=0 if variant == "clean" else (6 if variant == "light" else (16 if variant == "heavy" else 8)),
            variant=variant,
            seed=days_ago * 97 + hour,
        )
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=88)
        data = buf.getvalue()
        digest = sha256_of(data)
        path = root / "demo" / f"{digest[:32]}.jpg"
        path.write_bytes(data)
        row = PanelImage(
            device_id=device.id,
            filename=path.name,
            path=str(path),
            url=f"/media/demo/{path.name}",
            captured_at=captured,
            source="demo",
            uploaded_by="seed",
            sha256=digest,
            size_bytes=len(data),
            width=image.width,
            height=image.height,
        )
        db.add(row)
        db.flush()

        result = demo_heuristic(image)
        db.add(
            AiPrediction(
                image_id=row.id,
                device_id=device.id,
                predicted_class=result.predicted_class,
                confidence=float(result.confidence),
                probabilities_json=json.dumps(result.probabilities),
                model_name=result.model_name,
                model_version=result.model_version,
                inference_ms=result.inference_ms,
                recommendation="",
                source="demo",
                demo=True,
                quality_warnings="; ".join(result.warnings),
                created_at=captured,
            )
        )
        db.add(GroundTruthLabel(image_id=row.id, label=true_class, labeled_by="demo-generator"))
        created += 1
    db.commit()
    return created


def seed_month_history(db: Session, device: Device) -> None:
    """A month of demo operational history: cleaning jobs, events and alerts."""
    if db.execute(select(func.count()).select_from(CleaningJob)).scalar_one():
        return
    now = datetime.now(timezone.utc)

    def days_ago(d: int, hour: int, minute: int = 0) -> datetime:
        return (now - timedelta(days=d)).replace(hour=hour, minute=minute, second=0, microsecond=0)

    jobs_spec = [
        (21, 9, 32, 301.5, 347.8, 186.0, 14.2, 214.0),
        (12, 10, 5, 304.9, 345.1, 178.0, 13.8, 205.0),
        (4, 9, 41, 297.6, 342.4, 191.0, 14.5, 218.0),
    ]
    for d, hour, minute, before, after, duration_s, water, energy in jobs_spec:
        start = days_ago(d, hour, minute)
        db.add(
            CleaningJob(
                device_id=device.id,
                status="completed",
                trigger="automatic",
                initiated_by="system",
                reason="Automatic cycle: simulated soiling loss exceeded threshold",
                requested_at=start - timedelta(minutes=6),
                started_at=start,
                completed_at=start + timedelta(seconds=duration_s),
                duration_s=duration_s,
                water_liters=water,
                energy_wh=energy,
                power_before_w=before,
                power_after_w=after,
                delta_pct=round((after - before) / before * 100.0, 1),
                measurement_note="Simulated before/after electrical snapshot",
                simulated=True,
            )
        )

    events_spec = [
        (29, 8, "device_connected", "info", "Controller reconnected after scheduled maintenance."),
        (26, 11, "settings_changed", "info", "Nightly report schedule updated (demo)."),
        (22, 17, "cleaning_recommended", "warning", "Estimated soiling loss crossed 8% - cleaning recommended."),
        (21, 9, "cleaning_started", "info", "Automatic cleaning cycle started (simulated)."),
        (21, 9, "cleaning_completed", "success", "Automatic cleaning cycle completed (simulated)."),
        (17, 14, "sensor_offline", "warning", "Irradiance sensor reported stale values for 12 minutes."),
        (17, 15, "device_connected", "info", "Irradiance sensor recovered and is reporting again."),
        (13, 16, "cleaning_recommended", "warning", "Soiling accumulation trend rising - cleaning recommended."),
        (12, 10, "cleaning_completed", "success", "Automatic cleaning cycle completed (simulated)."),
        (9, 12, "soiling_threshold_crossed", "warning", "Soiling loss estimate crossed the configured warning threshold."),
        (5, 21, "login", "info", "User signed in from web dashboard."),
        (4, 9, "cleaning_completed", "success", "Automatic cleaning cycle completed (simulated)."),
        (1, 18, "data_exported", "info", "Telemetry export generated for the demo period."),
    ]
    for d, hour, etype, status, text in events_spec:
        db.add(
            SystemEvent(
                ts=days_ago(d, hour),
                event_type=etype,
                device_id=device.id,
                description=text,
                status=status,
                actor="Ramnath" if etype == "login" else "system",
            )
        )

    alerts_spec = [
        (22, "warning", "Soiling loss above 8%", "Estimated soiling loss reached 8.4% on Roof Array A (simulated)."),
        (17, "warning", "Irradiance sensor stale", "Irradiance readings were stale for 12 minutes (simulated fault)."),
        (12, "info", "Cleaning cycle completed", "Automatic cleaning completed with a +13.1% simulated power recovery."),
        (1, "info", "Monthly demo report ready", "A 30-day simulated performance summary is available."),
    ]
    for d, sev, title, message in alerts_spec:
        db.add(
            Alert(
                ts=days_ago(d, 18),
                severity=sev,
                title=title,
                message=message,
                category="system",
                read=d > 1,
                device_id=device.id,
            )
        )
    db.commit()


def seed_first_run(db: Session) -> None:
    has_events = db.execute(select(func.count()).select_from(SystemEvent)).scalar_one()
    if has_events:
        return
    log_event(
        db,
        "model_status",
        "Initial deployment state recorded. AI model weights are not bundled; predictions run in clearly marked demo mode.",
        status="warning",
        actor="system",
    )
    create_alert(
        db,
        "info",
        "Demo mode active",
        "This deployment runs with simulated telemetry and a demo classification rule. No value shown is a field measurement.",
        category="system",
    )


def seed_all(db: Session) -> dict:
    seed_users(db)
    device = seed_device(db)
    seed_month_history(db, device)
    images = seed_demo_imagery(db, device)
    seed_first_run(db)
    return {"device": device.id, "demo_images": images}
