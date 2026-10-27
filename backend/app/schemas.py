"""Pydantic request/response schemas (mirrored by frontend/src/lib/types.ts)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

DataSource = Literal["measured", "simulated", "estimated", "demo"]
Role = Literal["admin", "operator", "viewer"]
CleaningPolicy = Literal["monitoring_only", "recommendation_only", "manual_approval", "automatic"]
Severity = Literal["info", "warning", "critical"]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ------------------------------- auth ---------------------------------
class LoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=3, max_length=128)


class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role: Role


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ------------------------------- system -------------------------------
class HealthResponse(BaseModel):
    status: str
    version: str
    demo_mode: bool
    database: str
    model_available: bool
    mqtt_connected: bool
    time: datetime


class ModelInfo(BaseModel):
    available: bool
    name: str
    version: str
    framework: str
    classes: list[str]
    input_size: tuple[int, int] = (224, 224)
    trained_for_four_class: bool = False
    trained_on: str | None = None
    notes: str = ""


class SystemStatus(BaseModel):
    operating_mode: Literal[
        "DEMO MODE",
        "HARDWARE CONNECTED",
        "HARDWARE OFFLINE",
        "AI MODEL UNAVAILABLE",
        "CLEANING IN PROGRESS",
        "FAULT DETECTED",
    ]
    demo_mode: bool
    hardware_connected: bool
    hardware_online: bool
    cleaning_in_progress: bool
    fault_active: bool
    active_alerts: int
    unread_alerts: int
    last_telemetry_at: datetime | None
    last_image_at: datetime | None
    last_inference_at: datetime | None
    last_cleaning_at: datetime | None
    model: ModelInfo
    primary_device_id: str | None
    telemetry_source: DataSource


# ----------------------------- telemetry ------------------------------
class TelemetryPoint(BaseModel):
    ts: datetime
    voltage_v: float | None = None
    current_a: float | None = None
    power_w: float | None = None
    panel_temp_c: float | None = None
    ambient_temp_c: float | None = None
    humidity_pct: float | None = None
    irradiance_wm2: float | None = None
    source: DataSource = "simulated"
    quality: Literal["good", "stale", "missing"] = "good"


class TelemetryResponse(BaseModel):
    device_id: str
    range: str
    source: DataSource
    simulated: bool
    count: int
    interval_s: float
    downsampled: bool = False
    points: list[TelemetryPoint]


# ------------------------------ devices -------------------------------
class PvModuleOut(ORMModel):
    id: int
    device_id: str
    name: str
    rated_power_w: float
    vmp_v: float
    imp_a: float
    technology: str


class DeviceOut(BaseModel):
    id: str
    display_name: str
    location: str
    status: Literal["online", "offline", "inactive", "unknown"]
    panel_rating_w: float
    camera_status: str
    electrical_sensor_status: str
    controller_status: str
    firmware_version: str | None
    telemetry_topic: str
    command_topic: str
    last_heartbeat: datetime | None
    operating_mode: str
    simulated: bool
    created_at: datetime
    active: bool = True
    has_irradiance_sensor: bool = False
    has_climate_sensor: bool = False
    actuator_type: str = "pump"
    modules: list[PvModuleOut] = []


class DeviceCreate(BaseModel):
    id: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    display_name: str = Field(min_length=2, max_length=120)
    location: str = Field(default="", max_length=160)
    panel_rating_w: float = Field(default=400.0, gt=0, le=10_000)
    telemetry_topic: str = Field(default="", max_length=160)
    command_topic: str = Field(default="", max_length=160)
    actuator_type: Literal["pump", "motor", "wiper", "none"] = "pump"
    has_irradiance_sensor: bool = False
    has_climate_sensor: bool = False
    simulated: bool = True


class DeviceUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=120)
    location: str | None = Field(default=None, max_length=160)
    panel_rating_w: float | None = Field(default=None, gt=0, le=10_000)
    telemetry_topic: str | None = Field(default=None, max_length=160)
    command_topic: str | None = Field(default=None, max_length=160)
    actuator_type: Literal["pump", "motor", "wiper", "none"] | None = None
    has_irradiance_sensor: bool | None = None
    has_climate_sensor: bool | None = None
    active: bool | None = None
    status: Literal["online", "offline", "inactive", "unknown"] | None = None


class ConnectionEventOut(ORMModel):
    ts: datetime
    status: str
    detail: str


# ------------------------------ overview ------------------------------
class OverviewMetrics(BaseModel):
    device_id: str
    source: DataSource
    simulated: bool
    voltage_v: float | None
    current_a: float | None
    power_w: float | None
    energy_today_wh: float | None
    prev_power_w: float | None
    prev_energy_wh: float | None
    soiling_class: str | None
    soiling_label: str | None
    soiling_confidence: float | None
    soiling_severity_pct: float | None
    last_cleaning_at: datetime | None
    operating_mode: str
    quality_note: str | None


class ConditionCard(BaseModel):
    image_id: str | None
    image_url: str | None
    predicted_class: str | None
    predicted_label: str | None
    confidence: float | None
    captured_at: datetime | None
    model_version: str | None
    recommendation: str | None
    source: DataSource | None


class AlertOut(ORMModel):
    id: str
    ts: datetime
    severity: Severity
    title: str
    message: str
    category: str
    read: bool
    device_id: str | None


class ActivityFeed(BaseModel):
    last_sensor_at: datetime | None
    last_image_at: datetime | None
    last_inference_at: datetime | None
    last_cleaning_at: datetime | None
    operating_mode: str
    active_alerts: list[AlertOut]


class EnergyRecovery(BaseModel):
    available: bool
    note: str
    power_before_w: float | None
    power_after_w: float | None
    delta_pct: float | None
    cleaning_energy_wh: float | None
    recovered_energy_wh: float | None
    measured: bool


class OverviewResponse(BaseModel):
    metrics: OverviewMetrics
    condition: ConditionCard
    activity: ActivityFeed
    recovery: EnergyRecovery


# -------------------------------- AI ----------------------------------
class PredictionOut(BaseModel):
    id: str
    image_id: str
    image_url: str
    predicted_class: str
    predicted_label: str
    confidence: float
    probabilities: dict[str, float]
    model_name: str
    model_version: str
    inference_ms: float
    captured_at: datetime
    created_at: datetime
    source: DataSource
    recommendation: str
    demo: bool
    confirmed_class: str | None
    gradcam_url: str | None
    quality_warnings: list[str]


class DecisionEvidence(BaseModel):
    label: str
    value: str
    impact: Literal["supports_cleaning", "against_cleaning", "neutral"]


class DecisionOut(BaseModel):
    id: str
    device_id: str
    action: Literal[
        "no_action",
        "cleaning_recommended",
        "cleaning_required",
        "cleaning_deferred",
        "insufficient_data",
        "possible_sensor_fault",
    ]
    action_label: str
    confidence: float
    explanation: str
    generated_at: datetime
    policy: CleaningPolicy
    certainty: Literal["high", "medium", "low"]
    inputs: dict[str, Any]
    evidence: list[DecisionEvidence]
    source: DataSource


class PredictResponse(BaseModel):
    prediction: PredictionOut
    decision: DecisionOut | None
    model_available: bool
    message: str


class ConfirmRequest(BaseModel):
    confirmed_class: str


# ------------------------------ cleaning ------------------------------
class CleaningStatusOut(BaseModel):
    device_id: str
    hardware_online: bool
    actuator: str
    actuator_state: str
    water_level_pct: float | None
    water_sensor_present: bool
    interlock_ok: bool
    interlock_reason: str | None
    fault: str | None
    cycles_completed: int
    cycles_failed: int
    last_cycle_at: datetime | None
    last_cycle_duration_s: float | None
    water_consumed_l: float | None
    energy_consumed_wh: float | None
    cooldown_remaining_s: float
    max_runtime_s: float
    auto_cleaning_enabled: bool
    policy: str
    current_job: "CleaningJobOut | None"
    can_start: bool
    cannot_start_reason: str | None
    simulated: bool


class CleaningJobOut(ORMModel):
    id: str
    device_id: str
    status: str
    trigger: str
    initiated_by: str
    reason: str
    requested_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    duration_s: float | None
    water_liters: float | None
    energy_wh: float | None
    error: str | None
    power_before_w: float | None
    power_after_w: float | None
    delta_pct: float | None
    acknowledged: bool
    simulated: bool


class CleaningRequest(BaseModel):
    device_id: str
    reason: str = Field(default="Manual request", max_length=255)
    confirm: bool = False
    trigger: Literal["manual", "automatic", "schedule", "test"] = "manual"


class CleaningStopRequest(BaseModel):
    device_id: str
    confirm: bool = False
    reason: str = Field(default="Operator stop", max_length=255)


class ActuatorTestRequest(BaseModel):
    device_id: str


class AutoCleaningRequest(BaseModel):
    device_id: str
    enabled: bool


class CleaningHistoryResponse(BaseModel):
    items: list[CleaningJobOut]
    total: int
    simulated: bool


# ------------------------------- events -------------------------------
class EventOut(BaseModel):
    id: str
    ts: datetime
    event_type: str
    event_label: str
    device_id: str | None
    description: str
    status: str
    actor: str
    reference: str | None


class EventListResponse(BaseModel):
    items: list[EventOut]
    total: int
    page: int
    page_size: int
    event_types: list[str]


class AlertListResponse(BaseModel):
    items: list[AlertOut]
    unread: int


# ------------------------------ analytics -----------------------------
class AnalyticsSummaryOut(BaseModel):
    source: DataSource
    simulated: bool
    classification_counts: dict[str, int]
    detections_over_time: list[dict[str, Any]]
    confidence_histogram: list[dict[str, Any]]
    cleaning_recommendations: int
    confirmed_cleaning_events: int
    power_before_after: list[dict[str, Any]]
    energy_series: list[dict[str, Any]]
    perf_series: list[dict[str, Any]]
    cleaning_stats: dict[str, Any]
    model_metrics: dict[str, Any]
    power_recovery: dict[str, Any]


# ------------------------------ settings ------------------------------
class SettingsOut(BaseModel):
    soiling_threshold_pct: float
    min_model_confidence: float
    reference_power_method: Literal["fixed_rated", "rolling_peak", "manual"]
    reference_power_w: float | None
    max_power_loss_pct: float
    sensor_freshness_s: float
    cleaning_cooldown_s: float
    max_cleaning_runtime_s: float
    min_interval_s: float
    policy: CleaningPolicy
    schedule_enabled: bool
    schedule_cron: str | None
    notify_email_enabled: bool
    notify_critical_only: bool
    data_retention_days: int
    mqtt_host: str
    mqtt_port: int
    mqtt_topic_prefix: str
    demo_mode: bool
    updated_at: datetime | None = None
    updated_by: str | None = None

    @field_validator("min_model_confidence")
    @classmethod
    def _conf(cls, v: float) -> float:
        if not 0 <= v <= 1:
            raise ValueError("min_model_confidence must be between 0 and 1")
        return v


class SettingsUpdate(BaseModel):
    soiling_threshold_pct: float | None = Field(default=None, ge=1, le=95)
    min_model_confidence: float | None = Field(default=None, ge=0, le=1)
    reference_power_method: Literal["fixed_rated", "rolling_peak", "manual"] | None = None
    reference_power_w: float | None = Field(default=None, gt=0)
    max_power_loss_pct: float | None = Field(default=None, ge=1, le=95)
    sensor_freshness_s: float | None = Field(default=None, ge=5, le=86_400)
    cleaning_cooldown_s: float | None = Field(default=None, ge=60)
    max_cleaning_runtime_s: float | None = Field(default=None, ge=10, le=3_600)
    min_interval_s: float | None = Field(default=None, ge=60)
    policy: CleaningPolicy | None = None
    schedule_enabled: bool | None = None
    schedule_cron: str | None = Field(default=None, max_length=64)
    notify_email_enabled: bool | None = None
    notify_critical_only: bool | None = None
    data_retention_days: int | None = Field(default=None, ge=1, le=3_650)
    mqtt_host: str | None = Field(default=None, max_length=120)
    mqtt_port: int | None = Field(default=None, ge=1, le=65_535)
    mqtt_topic_prefix: str | None = Field(default=None, max_length=64)
    demo_mode: bool | None = None


class SettingsResponse(BaseModel):
    settings: SettingsOut
    warnings: list[dict[str, str]] = []


class OkResponse(BaseModel):
    ok: bool = True
    detail: str = ""
