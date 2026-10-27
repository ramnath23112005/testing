import type {
  AlertListResponse,
  AnalyticsSummary,
  AuthResponse,
  CleaningHistoryResponse,
  CleaningJob,
  CleaningStatus,
  Decision,
  Device,
  DeviceConnectionEvent,
  EventListResponse,
  HealthResponse,
  ModelInfo,
  OperatingMode,
  OverviewResponse,
  Prediction,
  PredictResponse,
  SettingsResponse,
  SystemStatus,
  TelemetryResponse,
  User,
} from "./types";

const TOKEN_KEY = "sg.token";
const USER_KEY = "sg.user";

export class ApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = message;
  }
}

export const authEvents = new EventTarget();

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  authEvents.dispatchEvent(new Event("logout"));
}

export function mediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return path.startsWith("/") ? path : `/${path}`;
}

type QueryValue = string | number | boolean | null | undefined;

function buildQuery(params?: Record<string, QueryValue>): string {
  if (!params) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") return data.detail;
    if (Array.isArray(data?.detail)) {
      return data.detail
        .map((d: { loc?: (string | number)[]; msg?: string }) =>
          `${(d.loc ?? []).slice(1).join(".")}: ${d.msg ?? "invalid"}`,
        )
        .join("; ");
    }
    if (typeof data?.message === "string") return data.message;
    return JSON.stringify(data);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

// The backend stores/serves naive UTC timestamps; without a "Z" suffix the JS
// Date parser would treat them as browser-local time and shift every label.
const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/;

export function normalizeTimestamps<T>(value: T): T {
  if (typeof value === "string") {
    return (NAIVE_ISO.test(value) ? `${value}Z` : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeTimestamps(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      (value as Record<string, unknown>)[k] = normalizeTimestamps(v);
    }
    return value;
  }
  return value;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, "Cannot reach the API server. Check that the backend is running.");
  }
  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, "Session expired. Please sign in again.");
  }
  if (!res.ok) {
    throw new ApiError(res.status, await parseError(res));
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return normalizeTimestamps(JSON.parse(text) as T);
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export const api = {
  /* ----------------------------- auth ----------------------------- */
  login: (username: string, password: string) =>
    request<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<User>("/api/auth/me"),

  /* ----------------------------- system --------------------------- */
  health: (o?: RequestOptions) => request<HealthResponse>("/api/health", o),
  status: (o?: RequestOptions) => request<SystemStatus>("/api/system/status", o),
  overview: (deviceId?: string, o?: RequestOptions) =>
    request<OverviewResponse>(`/api/overview${buildQuery({ device_id: deviceId })}`, o),

  /* ---------------------------- devices --------------------------- */
  devices: (o?: RequestOptions) => request<Device[]>("/api/devices", o),
  device: (id: string) => request<Device>(`/api/devices/${id}`),
  createDevice: (body: Partial<Device>) =>
    request<Device>("/api/devices", { method: "POST", body: JSON.stringify(body) }),
  updateDevice: (id: string, body: Partial<Device>) =>
    request<Device>(`/api/devices/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  testDevice: (id: string) =>
    request<{ ok: boolean; detail: string }>(`/api/devices/${id}/test`, { method: "POST" }),
  deviceHistory: (id: string) => request<DeviceConnectionEvent[]>(`/api/devices/${id}/connection-history`),

  /* --------------------------- telemetry -------------------------- */
  telemetry: (
    deviceId: string,
    params: { range?: string; from?: string; to?: string; limit?: number } = {},
    o?: RequestOptions,
  ) =>
    request<TelemetryResponse>(
      `/api/devices/${deviceId}/telemetry${buildQuery(params)}`,
      o,
    ),

  /* ------------------------------ ai ------------------------------ */
  modelInfo: (o?: RequestOptions) => request<ModelInfo>("/api/ai/model", o),
  predict: (file: File, deviceId?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (deviceId) fd.append("device_id", deviceId);
    return request<PredictResponse>("/api/ai/predict", { method: "POST", body: fd });
  },
  predictDemo: (file: File, deviceId?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (deviceId) fd.append("device_id", deviceId);
    return request<PredictResponse>("/api/ai/predict?demo=1", { method: "POST", body: fd });
  },
  captureImage: (deviceId: string) =>
    request<{ image_id: string; image_url: string; captured_at: string; source: string }>(
      "/api/ai/capture",
      { method: "POST", body: JSON.stringify({ device_id: deviceId }) },
    ),
  predictions: (params: { from?: string; to?: string; predicted_class?: string; page?: number; page_size?: number } = {}) =>
    request<{ items: Prediction[]; total: number; page: number; page_size: number }>(
      `/api/ai/predictions${buildQuery(params)}`,
    ),
  confirmPrediction: (id: string, confirmedClass: string) =>
    request<Prediction>(`/api/ai/predictions/${id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ confirmed_class: confirmedClass }),
    }),
  deleteImage: (imageId: string) =>
    request<void>(`/api/ai/images/${imageId}`, { method: "DELETE" }),

  /* --------------------------- decision --------------------------- */
  latestDecision: (deviceId?: string) =>
    request<Decision | null>(`/api/decision/latest${buildQuery({ device_id: deviceId })}`),
  evaluateDecision: (deviceId?: string) =>
    request<Decision>(`/api/decision/evaluate${buildQuery({ device_id: deviceId })}`, { method: "POST" }),

  /* --------------------------- cleaning --------------------------- */
  cleaningStatus: (deviceId?: string) =>
    request<CleaningStatus>(`/api/cleaning/status${buildQuery({ device_id: deviceId })}`),
  requestCleaning: (deviceId: string, reason: string) =>
    request<{ job: CleaningJob; detail: string }>("/api/cleaning/request", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId, reason, confirm: true }),
    }),
  stopCleaning: (deviceId: string) =>
    request<{ job: CleaningJob | null; detail: string }>("/api/cleaning/stop", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId, confirm: true }),
    }),
  testActuator: (deviceId: string) =>
    request<{ ok: boolean; detail: string }>("/api/cleaning/test", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId }),
    }),
  toggleAutoCleaning: (deviceId: string, enabled: boolean) =>
    request<CleaningStatus>("/api/cleaning/auto", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId, enabled }),
    }),
  cleaningHistory: (params: { page?: number; page_size?: number } = {}) =>
    request<CleaningHistoryResponse>(`/api/cleaning/history${buildQuery(params)}`),

  /* --------------------------- analytics -------------------------- */
  analyticsSummary: (params: { from?: string; to?: string } = {}) =>
    request<AnalyticsSummary>(`/api/analytics/summary${buildQuery(params)}`),

  /* ---------------------------- events ---------------------------- */
  events: (params: Record<string, QueryValue> = {}) =>
    request<EventListResponse>(`/api/events${buildQuery(params)}`),
  event: (id: string) => request<EventListResponse["items"][number]>(`/api/events/${id}`),

  /* ---------------------------- alerts ---------------------------- */
  alerts: () => request<AlertListResponse>("/api/alerts"),
  markAlertRead: (id: string) => request<AlertListResponse>(`/api/alerts/${id}/read`, { method: "POST" }),
  markAllAlertsRead: () => request<AlertListResponse>("/api/alerts/read-all", { method: "POST" }),

  /* ---------------------------- settings -------------------------- */
  settings: (o?: RequestOptions) => request<SettingsResponse>("/api/settings", o),
  updateSettings: (body: Record<string, unknown>) =>
    request<SettingsResponse>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  /* ----------------------------- export --------------------------- */
  async csvDownload(path: string, filename: string, params?: Record<string, QueryValue>) {
    const token = getToken();
    const res = await fetch(`${path}${buildQuery(params)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new ApiError(res.status, await parseError(res));
    const text = await res.text();
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};

export type OperatingModeLabel = OperatingMode;
