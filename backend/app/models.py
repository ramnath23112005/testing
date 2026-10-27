"""Persistent data models (PostgreSQL via SQLAlchemy; SQLite fallback for dev)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(120), default="")
    role: Mapped[str] = mapped_column(String(16), default="viewer")  # admin | operator | viewer
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Device(Base, TimestampMixin):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    location: Mapped[str] = mapped_column(String(160), default="")
    status: Mapped[str] = mapped_column(String(16), default="offline")  # online|offline|inactive|unknown
    panel_rating_w: Mapped[float] = mapped_column(Float, default=400.0)
    camera_status: Mapped[str] = mapped_column(String(16), default="unknown")
    electrical_sensor_status: Mapped[str] = mapped_column(String(16), default="unknown")
    controller_status: Mapped[str] = mapped_column(String(16), default="unknown")
    firmware_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    telemetry_topic: Mapped[str] = mapped_column(String(160), default="")
    command_topic: Mapped[str] = mapped_column(String(160), default="")
    last_heartbeat: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    simulated: Mapped[bool] = mapped_column(Boolean, default=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    has_irradiance_sensor: Mapped[bool] = mapped_column(Boolean, default=False)
    has_climate_sensor: Mapped[bool] = mapped_column(Boolean, default=False)
    actuator_type: Mapped[str] = mapped_column(String(24), default="pump")  # pump|motor|wiper|none

    modules: Mapped[list["PvModule"]] = relationship(back_populates="device", cascade="all, delete-orphan")
    connection_events: Mapped[list["DeviceConnectionEvent"]] = relationship(
        back_populates="device", cascade="all, delete-orphan"
    )


class PvModule(Base, TimestampMixin):
    __tablename__ = "pv_modules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(64), default="Module A")
    rated_power_w: Mapped[float] = mapped_column(Float, default=400.0)
    vmp_v: Mapped[float] = mapped_column(Float, default=37.2)
    imp_a: Mapped[float] = mapped_column(Float, default=10.8)
    technology: Mapped[str] = mapped_column(String(32), default="mono-PERC")

    device: Mapped[Device] = relationship(back_populates="modules")


class DeviceConnectionEvent(Base):
    __tablename__ = "device_connection_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    status: Mapped[str] = mapped_column(String(16))
    detail: Mapped[str] = mapped_column(String(255), default="")

    device: Mapped[Device] = relationship(back_populates="connection_events")


class TelemetryReading(Base):
    __tablename__ = "telemetry_readings"
    __table_args__ = (Index("ix_telemetry_device_ts", "device_id", "ts"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    voltage_v: Mapped[float | None] = mapped_column(Float, nullable=True)
    current_a: Mapped[float | None] = mapped_column(Float, nullable=True)
    power_w: Mapped[float | None] = mapped_column(Float, nullable=True)
    panel_temp_c: Mapped[float | None] = mapped_column(Float, nullable=True)
    ambient_temp_c: Mapped[float | None] = mapped_column(Float, nullable=True)
    humidity_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    irradiance_wm2: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="simulated")  # measured|simulated|estimated|demo
    quality: Mapped[str] = mapped_column(String(16), default="good")  # good|stale|missing


class PanelImage(Base, TimestampMixin):
    __tablename__ = "panel_images"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"), nullable=True, index=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    path: Mapped[str] = mapped_column(String(512), nullable=False)
    url: Mapped[str] = mapped_column(String(512), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    source: Mapped[str] = mapped_column(String(16), default="upload")  # upload|camera|demo
    uploaded_by: Mapped[str] = mapped_column(String(64), default="system")
    sha256: Mapped[str] = mapped_column(String(64), default="")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)


class AiPrediction(Base, TimestampMixin):
    __tablename__ = "ai_predictions"
    __table_args__ = (Index("ix_predictions_device_created", "device_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    image_id: Mapped[str | None] = mapped_column(ForeignKey("panel_images.id", ondelete="SET NULL"), nullable=True)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    predicted_class: Mapped[str] = mapped_column(String(32), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    probabilities_json: Mapped[str] = mapped_column(Text, default="{}")
    model_name: Mapped[str] = mapped_column(String(96), default="unavailable")
    model_version: Mapped[str] = mapped_column(String(32), default="0.0.0")
    inference_ms: Mapped[float] = mapped_column(Float, default=0.0)
    recommendation: Mapped[str] = mapped_column(String(255), default="")
    source: Mapped[str] = mapped_column(String(16), default="simulated")  # measured|demo|simulated
    demo: Mapped[bool] = mapped_column(Boolean, default=False)
    confirmed_class: Mapped[str | None] = mapped_column(String(32), nullable=True)
    gradcam_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    quality_warnings: Mapped[str] = mapped_column(String(255), default="")

    image: Mapped[PanelImage | None] = relationship(backref="predictions")


class CleaningJob(Base, TimestampMixin):
    __tablename__ = "cleaning_jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|running|completed|failed|aborted|stopped
    trigger: Mapped[str] = mapped_column(String(16), default="manual")  # manual|automatic|schedule|test
    initiated_by: Mapped[str] = mapped_column(String(64), default="system")
    reason: Mapped[str] = mapped_column(String(255), default="")
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    water_liters: Mapped[float | None] = mapped_column(Float, nullable=True)
    energy_wh: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str | None] = mapped_column(String(255), nullable=True)
    power_before_w: Mapped[float | None] = mapped_column(Float, nullable=True)
    power_after_w: Mapped[float | None] = mapped_column(Float, nullable=True)
    delta_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    measurement_note: Mapped[str] = mapped_column(String(255), default="")
    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False)
    simulated: Mapped[bool] = mapped_column(Boolean, default=True)


class CleaningMeasurement(Base):
    """Before/after electrical snapshots captured around a cleaning cycle."""

    __tablename__ = "cleaning_measurements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("cleaning_jobs.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(8))  # before|after
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    power_w: Mapped[float | None] = mapped_column(Float, nullable=True)
    voltage_v: Mapped[float | None] = mapped_column(Float, nullable=True)
    current_a: Mapped[float | None] = mapped_column(Float, nullable=True)
    irradiance_wm2: Mapped[float | None] = mapped_column(Float, nullable=True)
    panel_temp_c: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="simulated")
    note: Mapped[str] = mapped_column(String(255), default="")


class SystemEvent(Base):
    """Append-only operational event log."""

    __tablename__ = "system_events"
    __table_args__ = (Index("ix_events_ts_type", "ts", "event_type"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    event_type: Mapped[str] = mapped_column(String(48), index=True)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    description: Mapped[str] = mapped_column(String(512), default="")
    status: Mapped[str] = mapped_column(String(16), default="info")  # info|warning|critical|success
    actor: Mapped[str] = mapped_column(String(64), default="system")
    reference: Mapped[str | None] = mapped_column(String(64), nullable=True)


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    severity: Mapped[str] = mapped_column(String(16), default="info")  # info|warning|critical
    title: Mapped[str] = mapped_column(String(120))
    message: Mapped[str] = mapped_column(String(512))
    category: Mapped[str] = mapped_column(String(48), default="system")
    read: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class Setting(Base, TimestampMixin):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text, default="{}")
    updated_by: Mapped[str] = mapped_column(String(64), default="system")


class AuditLog(Base):
    """Append-only audit trail for privileged actions."""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(64), index=True)
    action: Mapped[str] = mapped_column(String(64))
    target: Mapped[str] = mapped_column(String(120), default="")
    detail: Mapped[str] = mapped_column(String(1024), default="")
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    success: Mapped[bool] = mapped_column(Boolean, default=True)


class CleaningDecision(Base):
    """Persisted sensor-fusion decision with its supporting evidence."""

    __tablename__ = "cleaning_decisions"
    __table_args__ = (Index("ix_decisions_device_ts", "device_id", "ts"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    action: Mapped[str] = mapped_column(String(32))
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    explanation: Mapped[str] = mapped_column(Text, default="")
    policy: Mapped[str] = mapped_column(String(24), default="monitoring_only")
    certainty: Mapped[str] = mapped_column(String(8), default="low")
    inputs_json: Mapped[str] = mapped_column(Text, default="{}")
    evidence_json: Mapped[str] = mapped_column(Text, default="[]")
    source: Mapped[str] = mapped_column(String(16), default="simulated")


class GroundTruthLabel(Base):
    """Optional independently verified labels used for model evaluation only."""

    __tablename__ = "ground_truth_labels"
    __table_args__ = (UniqueConstraint("image_id", name="uq_ground_truth_image"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    image_id: Mapped[str] = mapped_column(ForeignKey("panel_images.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(32))
    labeled_by: Mapped[str] = mapped_column(String(64), default="expert")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
