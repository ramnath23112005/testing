/**
 * Shared API contract types. These mirror the Pydantic response models exposed
 * by the FastAPI backend (see backend/app/schemas.py).
 */

export type DataSource = "measured" | "simulated" | "estimated" | "demo";

export type OperatingMode =
  | "DEMO MODE"
  | "HARDWARE CONNECTED"
  | "HARDWARE OFFLINE"
  | "AI MODEL UNAVAILABLE"
  | "CLEANING IN PROGRESS"
  | "FAULT DETECTED";

export type DeviceStatus = "online" | "offline" | "inactive" | "unknown";

export type ComponentStatus = "ok" | "degraded" | "offline" | "unknown";

export type SoilingClass =
  | "clean"
  | "lightly_dusty"
  | "heavily_dusty"
  | "bird_dropping";

export type DecisionAction =
  | "no_action"
  | "cleaning_recommended"
  | "cleaning_required"
  | "cleaning_deferred"
  | "insufficient_data"
  | "possible_sensor_fault";

export type CleaningPolicy = "monitoring_only" | "recommendation_only" | "manual_approval" | "automatic";

export type CleaningJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "stopped";

export type Severity = "info" | "warning" | "critical";

export interface User {
  id: number;
  username: string;
  full_name: string;
  role: "admin" | "operator" | "viewer";
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export interface HealthResponse {
  status: string;
  version: string;
  demo_mode: boolean;
  database: string;
  model_available: boolean;
  mqtt_connected: boolean;
  time: string;
}

export interface ModelInfo {
  available: boolean;
  name: string;
  version: string;
  framework: string;
  classes: string[];
  input_size: [number, number];
  trained_for_four_class: boolean;
  trained_on: string | null;
  notes: string;
}

export interface SystemStatus {
  operating_mode: OperatingMode;
  demo_mode: boolean;
  hardware_connected: boolean;
  hardware_online: boolean;
  cleaning_in_progress: boolean;
  fault_active: boolean;
  active_alerts: number;
  unread_alerts: number;
  last_telemetry_at: string | null;
  last_image_at: string | null;
  last_inference_at: string | null;
  last_cleaning_at: string | null;
  model: ModelInfo;
  primary_device_id: string | null;
  telemetry_source: DataSource;
}

export interface TelemetryPoint {
  ts: string;
  voltage_v: number | null;
  current_a: number | null;
  power_w: number | null;
  panel_temp_c: number | null;
  ambient_temp_c: number | null;
  humidity_pct: number | null;
  irradiance_wm2: number | null;
  source: DataSource;
  quality: "good" | "stale" | "missing";
}

export interface TelemetryResponse {
  device_id: string;
  range: string;
  source: DataSource;
  simulated: boolean;
  count: number;
  interval_s: number;
  downsampled: boolean;
  points: TelemetryPoint[];
}

export interface Device {
  id: string;
  display_name: string;
  location: string;
  status: DeviceStatus;
  panel_rating_w: number;
  camera_status: ComponentStatus;
  electrical_sensor_status: ComponentStatus;
  controller_status: ComponentStatus;
  firmware_version: string | null;
  telemetry_topic: string;
  command_topic: string;
  last_heartbeat: string | null;
  operating_mode: OperatingMode;
  simulated: boolean;
  created_at: string;
  active: boolean;
  has_irradiance_sensor: boolean;
  has_climate_sensor: boolean;
  actuator_type: "pump" | "motor" | "wiper" | "none";
  modules: PvModule[];
}

export interface PvModule {
  id: number;
  device_id: string;
  name: string;
  rated_power_w: number;
  vmp_v: number;
  imp_a: number;
  technology: string;
}

export interface DeviceConnectionEvent {
  ts: string;
  status: DeviceStatus;
  detail: string;
}

export interface OverviewMetrics {
  device_id: string;
  source: DataSource;
  simulated: boolean;
  voltage_v: number | null;
  current_a: number | null;
  power_w: number | null;
  energy_today_wh: number | null;
  prev_power_w: number | null;
  prev_energy_wh: number | null;
  soiling_class: string | null;
  soiling_label: string | null;
  soiling_confidence: number | null;
  soiling_severity_pct: number | null;
  last_cleaning_at: string | null;
  operating_mode: OperatingMode;
  quality_note: string | null;
}

export interface ConditionCard {
  image_id: string | null;
  image_url: string | null;
  predicted_class: string | null;
  predicted_label: string | null;
  confidence: number | null;
  captured_at: string | null;
  model_version: string | null;
  recommendation: string | null;
  source: DataSource | null;
}

export interface ActivityFeed {
  last_sensor_at: string | null;
  last_image_at: string | null;
  last_inference_at: string | null;
  last_cleaning_at: string | null;
  operating_mode: OperatingMode;
  active_alerts: Alert[];
}

export interface EnergyRecovery {
  available: boolean;
  note: string;
  power_before_w: number | null;
  power_after_w: number | null;
  delta_pct: number | null;
  cleaning_energy_wh: number | null;
  recovered_energy_wh: number | null;
  measured: boolean;
}

export interface OverviewResponse {
  metrics: OverviewMetrics;
  condition: ConditionCard;
  activity: ActivityFeed;
  recovery: EnergyRecovery;
}

export interface PredictionProbabilities {
  [className: string]: number;
}

export interface Prediction {
  id: string;
  image_id: string;
  image_url: string;
  predicted_class: string;
  predicted_label: string;
  confidence: number;
  probabilities: PredictionProbabilities;
  model_name: string;
  model_version: string;
  inference_ms: number;
  captured_at: string;
  created_at: string;
  source: DataSource;
  recommendation: string;
  demo: boolean;
  confirmed_class: string | null;
  gradcam_url: string | null;
  quality_warnings: string[];
}

export interface PredictResponse {
  prediction: Prediction;
  decision: Decision | null;
  model_available: boolean;
  message: string;
}

export interface DecisionEvidence {
  label: string;
  value: string;
  impact: "supports_cleaning" | "against_cleaning" | "neutral";
}

export interface Decision {
  id: string;
  device_id: string;
  action: DecisionAction;
  action_label: string;
  confidence: number;
  explanation: string;
  generated_at: string;
  policy: CleaningPolicy;
  certainty: "high" | "medium" | "low";
  inputs: Record<string, string | number | boolean | null>;
  evidence: DecisionEvidence[];
  source: DataSource;
}

export interface CleaningStatus {
  device_id: string;
  hardware_online: boolean;
  actuator: "pump" | "motor" | "wiper" | "none";
  actuator_state: "idle" | "running" | "fault" | "unknown";
  water_level_pct: number | null;
  water_sensor_present: boolean;
  interlock_ok: boolean;
  interlock_reason: string | null;
  fault: string | null;
  cycles_completed: number;
  cycles_failed: number;
  last_cycle_at: string | null;
  last_cycle_duration_s: number | null;
  water_consumed_l: number | null;
  energy_consumed_wh: number | null;
  cooldown_remaining_s: number;
  max_runtime_s: number;
  auto_cleaning_enabled: boolean;
  policy: CleaningPolicy;
  current_job: CleaningJob | null;
  can_start: boolean;
  cannot_start_reason: string | null;
  simulated: boolean;
}

export interface CleaningJob {
  id: string;
  device_id: string;
  status: CleaningJobStatus;
  trigger: "manual" | "automatic" | "schedule" | "test";
  initiated_by: string;
  reason: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_s: number | null;
  water_liters: number | null;
  energy_wh: number | null;
  error: string | null;
  power_before_w: number | null;
  power_after_w: number | null;
  delta_pct: number | null;
  acknowledged: boolean;
  simulated: boolean;
}

export interface CleaningHistoryResponse {
  items: CleaningJob[];
  total: number;
  simulated: boolean;
}

export interface EventItem {
  id: string;
  ts: string;
  event_type: string;
  event_label: string;
  device_id: string | null;
  description: string;
  status: string;
  actor: string;
  reference: string | null;
}

export interface EventListResponse {
  items: EventItem[];
  total: number;
  page: number;
  page_size: number;
  event_types: string[];
}

export interface Alert {
  id: string;
  ts: string;
  severity: Severity;
  title: string;
  message: string;
  category: string;
  read: boolean;
  device_id: string | null;
}

export interface AlertListResponse {
  items: Alert[];
  unread: number;
}

export interface AppSettings {
  soiling_threshold_pct: number;
  min_model_confidence: number;
  reference_power_method: "fixed_rated" | "rolling_peak" | "manual";
  reference_power_w: number | null;
  max_power_loss_pct: number;
  sensor_freshness_s: number;
  cleaning_cooldown_s: number;
  max_cleaning_runtime_s: number;
  min_interval_s: number;
  policy: CleaningPolicy;
  schedule_enabled: boolean;
  schedule_cron: string | null;
  notify_email_enabled: boolean;
  notify_critical_only: boolean;
  data_retention_days: number;
  mqtt_host: string;
  mqtt_port: number;
  mqtt_topic_prefix: string;
  demo_mode: boolean;
  updated_at: string;
  updated_by: string;
}

export interface SettingsWarning {
  field: string;
  message: string;
}

export interface SettingsResponse {
  settings: AppSettings;
  warnings: SettingsWarning[];
}

export interface AnalyticsSummary {
  source: DataSource;
  simulated: boolean;
  classification_counts: Record<string, number>;
  detections_over_time: { date: string; count: number; avg_confidence: number }[];
  confidence_histogram: { bucket: string; count: number }[];
  cleaning_recommendations: number;
  confirmed_cleaning_events: number;
  power_before_after: { id: string; when: string; before_w: number; after_w: number; delta_pct: number }[];
  energy_series: { date: string; wh: number }[];
  perf_series: { ts: string; actual_w: number; reference_w: number; ratio: number }[];
  cleaning_stats: {
    cycles: number;
    failed: number;
    avg_duration_s: number;
    water_l: number;
    energy_wh: number;
    aborted: number;
    repeated_24h: number;
    success_rate_pct: number | null;
    success_criterion: string;
  };
  model_metrics: {
    available: boolean;
    note: string;
    accuracy: number | null;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    support: number | null;
  };
  power_recovery: {
    measured: boolean;
    note: string;
    avg_delta_pct: number | null;
    estimated_recovered_wh: number | null;
    cleaning_energy_wh: number | null;
  };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}
