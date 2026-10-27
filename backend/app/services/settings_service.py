"""Application settings: defaults, persistence and safety validation."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import Setting
from ..schemas import SettingsOut, SettingsUpdate

DEFAULTS: dict = {
    "soiling_threshold_pct": 8.0,           # normalised power loss (%) that supports cleaning
    "min_model_confidence": 0.65,           # visual prediction must reach this confidence
    "reference_power_method": "rolling_peak",
    "reference_power_w": None,
    "max_power_loss_pct": 30.0,             # hard cap: beyond this, suspect a fault, not dust
    "sensor_freshness_s": 300.0,
    "cleaning_cooldown_s": 1800.0,
    "max_cleaning_runtime_s": 300.0,
    "min_interval_s": 21600.0,
    "policy": "monitoring_only",
    "auto_cleaning_enabled": False,
    "schedule_enabled": False,
    "schedule_cron": None,
    "notify_email_enabled": False,
    "notify_critical_only": False,
    "data_retention_days": 365,
    "mqtt_host": "",
    "mqtt_port": 1883,
    "mqtt_topic_prefix": "soilingguard",
    "demo_mode": True,
}


def load_settings(db: Session) -> dict:
    values = dict(DEFAULTS)
    for row in db.query(Setting).all():
        try:
            payload = json.loads(row.value_json)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            values.update(payload)
        else:
            values[row.key] = payload
    # tie demo mode to deployment configuration unless explicitly overridden at runtime
    return values


def settings_out(db: Session) -> SettingsOut:
    values = load_settings(db)
    row = db.get(Setting, "app")
    return SettingsOut(
        **{k: values.get(k, DEFAULTS.get(k)) for k in SettingsOut.model_fields if k in values or k in DEFAULTS},
        updated_at=row.created_at if row else None,
        updated_by=row.updated_by if row else None,
    )


def save_settings(db: Session, update: SettingsUpdate, actor: str) -> SettingsOut:
    values = load_settings(db)
    changed = update.model_dump(exclude_unset=True)
    values.update({k: v for k, v in changed.items() if v is not None or k in ("reference_power_w", "schedule_cron")})
    payload = {k: values.get(k) for k in DEFAULTS}
    row = db.get(Setting, "app")
    if row is None:
        row = Setting(key="app", value_json=json.dumps(payload), updated_by=actor)
        db.add(row)
    else:
        row.value_json = json.dumps(payload)
        row.updated_by = actor
        row.created_at = datetime.now(timezone.utc)
    db.commit()
    return settings_out(db)


def validate_settings(values: dict) -> list[dict[str, str]]:
    """Return human-readable warnings for unsafe / unreasonable configuration."""
    warnings: list[dict[str, str]] = []
    if values["max_power_loss_pct"] > 40:
        warnings.append(
            {
                "field": "max_power_loss_pct",
                "message": "A power-loss cap above 40% is unusually permissive and will rarely distinguish soiling from faults (e.g. string failure or heavy shading).",
            }
        )
    if values["min_model_confidence"] < 0.5:
        warnings.append(
            {
                "field": "min_model_confidence",
                "message": "Minimum model confidence below 0.50 accepts predictions that are barely better than chance for a 4-class problem.",
            }
        )
    if values["sensor_freshness_s"] > 3600:
        warnings.append(
            {
                "field": "sensor_freshness_s",
                "message": "Sensor freshness above 1 hour allows cleaning decisions to be made on very stale measurements.",
            }
        )
    if values["cleaning_cooldown_s"] < 600:
        warnings.append(
            {
                "field": "cleaning_cooldown_s",
                "message": "Cooldown below 10 minutes can cause repeated cleaning cycles and unnecessary water use.",
            }
        )
    if values["max_cleaning_runtime_s"] > 900:
        warnings.append(
            {
                "field": "max_cleaning_runtime_s",
                "message": "Maximum runtime above 15 minutes increases the risk of water wastage and actuator wear. Verify your hardware interlocks.",
            }
        )
    if values["soiling_threshold_pct"] < 3:
        warnings.append(
            {
                "field": "soiling_threshold_pct",
                "message": "Threshold below 3% is within the measurement noise of most PV systems and will produce false recommendations.",
            }
        )
    if values["policy"] == "automatic" and values.get("demo_mode", False):
        warnings.append(
            {
                "field": "policy",
                "message": "Automatic policy while DEMO mode is active: no real hardware will be energised, but review this before going live.",
            }
        )
    if values["policy"] == "automatic" and not values["schedule_enabled"] and values["max_power_loss_pct"] > 30:
        warnings.append(
            {
                "field": "policy",
                "message": "Automatic cleaning is enabled while the power-loss cap is at its default. Consider tightening it before unattended operation.",
            }
        )
    if values["data_retention_days"] < 30:
        warnings.append(
            {
                "field": "data_retention_days",
                "message": "Retention below 30 days limits long-term performance analytics and incident investigation.",
            }
        )
    return warnings
