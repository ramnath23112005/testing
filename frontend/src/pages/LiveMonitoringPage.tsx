import * as React from "react";
import {
  Activity,
  CircleDot,
  Download,
  LineChart as LineChartIcon,
  RefreshCw,
  Thermometer,
} from "lucide-react";
import { api, getToken, normalizeTimestamps } from "@/lib/api";
import { RANGE_OPTIONS, RANGE_POLL_MS, useAsync, type RangeKey } from "@/lib/hooks";
import { useSystem } from "@/context/SystemContext";
import { cn, formatDateTime, formatNumber, formatTime } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  EmptyState,
  ErrorState,
  InfoBanner,
  PageHeader,
  SourceBadge,
} from "@/components/shared/indicators";
import {
  ChartFrame,
  ChartGrid,
  ChartTooltipContent,
  LegendDot,
  MultiLineChart,
  SERIES,
  TimeAxis,
} from "@/components/charts/chartkit";
import { Line, LineChart, Tooltip, YAxis } from "recharts";
import type { TelemetryPoint } from "@/lib/types";

const CLASS_INDEX: Record<string, number> = {
  clean: 3,
  lightly_dusty: 2,
  heavily_dusty: 1,
  bird_dropping: 0,
};

function toIsoLocal(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function wsHost(): string {
  // Vercel cannot proxy WebSockets; connect straight to the Render backend there.
  if (window.location.hostname.endsWith(".vercel.app")) {
    return "wss://soilingguard-pv-soiling-cleaning.onrender.com";
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

function useLiveSocket(deviceId: string | null) {
  const [state, setState] = React.useState<"connecting" | "live" | "polling">("polling");
  const [livePoint, setLivePoint] = React.useState<TelemetryPoint | null>(null);

  React.useEffect(() => {
    if (!deviceId) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      try {
        const token = getToken();
        socket = new WebSocket(
          `${wsHost()}/ws/telemetry?device_id=${encodeURIComponent(deviceId)}${token ? `&token=${encodeURIComponent(token)}` : ""}`,
        );
        setState("connecting");
        socket.onopen = () => {
          attempt = 0;
          setState("live");
        };
        socket.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data as string) as { type?: string; point?: TelemetryPoint };
            if (msg.type === "telemetry" && msg.point) setLivePoint(normalizeTimestamps(msg.point));
          } catch {
            /* ignore malformed frames */
          }
        };
        socket.onerror = () => {
          if (!closed) setState("polling");
        };
        socket.onclose = () => {
          if (closed) return;
          setState("polling");
          const delay = Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4));
          attempt += 1;
          retryTimer = setTimeout(connect, delay);
        };
      } catch {
        setState("polling");
      }
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [deviceId]);

  return { state, livePoint };
}

function StatTiles({ points, source }: { points: TelemetryPoint[]; source: "measured" | "simulated" | "estimated" | "demo" }) {
  const latest = points.length ? points[points.length - 1] : null;
  const nums = (key: keyof TelemetryPoint) =>
    points.map((p) => p[key]).filter((v): v is number => typeof v === "number");
  const stats = (key: keyof TelemetryPoint) => {
    const arr = nums(key);
    if (arr.length === 0) return { min: null, max: null, avg: null };
    return {
      min: Math.min(...arr),
      max: Math.max(...arr),
      avg: arr.reduce((a, b) => a + b, 0) / arr.length,
    };
  };
  const power = stats("power_w");
  const voltage = stats("voltage_v");
  const current = stats("current_a");

  const tiles = [
    { label: "Power now", value: latest?.power_w, unit: "W", s: power, digits: 0, color: SERIES.power },
    { label: "Voltage now", value: latest?.voltage_v, unit: "V", s: voltage, digits: 1, color: SERIES.voltage },
    { label: "Current now", value: latest?.current_a, unit: "A", s: current, digits: 2, color: SERIES.current },
    {
      label: "Irradiance now",
      value: latest?.irradiance_wm2,
      unit: "W/m²",
      s: stats("irradiance_wm2"),
      digits: 0,
      color: SERIES.irradiance,
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_6px_18px_-6px_rgba(15,23,42,0.06)] transition-shadow duration-200 hover:shadow-[0_2px_4px_rgba(15,23,42,0.05),0_14px_30px_-8px_rgba(15,23,42,0.1)]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-[0.1em] text-slate-600">{t.label}</span>
            {t.value != null ? (
              <SourceBadge source={source} />
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-slate-500">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full border border-slate-400" />
                No data
              </span>
            )}
          </div>

          <div className="mt-3 flex items-baseline gap-1.5">
            {t.value != null ? (
              <>
                <span className="text-[28px] font-bold leading-none tracking-tight tabular-nums text-slate-900">
                  {formatNumber(t.value, t.digits)}
                </span>
                <span className="text-sm font-semibold text-slate-500">{t.unit}</span>
              </>
            ) : (
              <>
                <span className="text-lg font-light leading-none text-slate-400">No live data</span>
                <span className="text-sm font-medium text-slate-400">{t.unit}</span>
              </>
            )}
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2">
            {(["min", "avg", "max"] as const).map((k) => (
              <div key={k} className="flex flex-col gap-1">
                <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-400">{k}</span>
                <span className="text-xs font-bold tabular-nums text-slate-700">
                  {t.s[k] != null ? formatNumber(t.s[k], t.digits) : "–"}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChartCard({
  title,
  description,
  children,
  legend,
  right,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  legend?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <LineChartIcon className="h-4 w-4 text-solar-600" /> {title}
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {right}
      </CardHeader>
      <CardContent>
        {children}
        {legend && <div className="mt-2 flex flex-wrap items-center gap-4">{legend}</div>}
      </CardContent>
    </Card>
  );
}

export default function LiveMonitoringPage() {
  const { selectedDeviceId, status, selectedDevice } = useSystem();
  const [range, setRange] = React.useState<RangeKey>("1h");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [exporting, setExporting] = React.useState(false);
  const { state: wsState, livePoint } = useLiveSocket(selectedDeviceId);

  const params = React.useMemo(
    () => ({
      range,
      from: range === "custom" ? toIsoLocal(from) : undefined,
      to: range === "custom" ? toIsoLocal(to) : undefined,
      limit: range === "15m" || range === "1h" ? 2000 : 4000,
    }),
    [range, from, to],
  );

  const telemetry = useAsync(
    (signal) =>
      selectedDeviceId
        ? api.telemetry(selectedDeviceId, params, { signal })
        : Promise.reject(new Error("No device selected. Register a device first.")),
    [selectedDeviceId, params.range, params.from, params.to],
    { pollMs: RANGE_POLL_MS[range] },
  );

  const predictions = useAsync(
    () =>
      selectedDeviceId
        ? api
            .predictions({
              from: params.from,
              to: params.to,
              page_size: 200,
            })
            .catch(() => ({ items: [], total: 0, page: 1, page_size: 200 }))
        : Promise.resolve({ items: [], total: 0, page: 1, page_size: 200 }),
    [selectedDeviceId, params.range, params.from, params.to],
    { pollMs: 60_000 },
  );

  const cleaning = useAsync(
    () => api.cleaningHistory({ page_size: 100 }).catch(() => ({ items: [], total: 0, simulated: true })),
    [selectedDeviceId],
    { pollMs: 60_000 },
  );

  const basePoints = telemetry.data?.points ?? [];
  const merged = React.useMemo(() => {
    if (!livePoint) return basePoints;
    const lastTs = basePoints.length ? basePoints[basePoints.length - 1].ts : null;
    if (lastTs && livePoint.ts <= lastTs) return basePoints;
    return [...basePoints, livePoint];
  }, [basePoints, livePoint]);

  const powerData = React.useMemo(() => {
    const events = (cleaning.data?.items ?? []).filter((j) => j.completed_at || j.started_at);
    const marked = merged.map((p) => ({ ...p, cleaning_mark: null as number | null }));
    for (const ev of events) {
      const at = ev.started_at ?? ev.completed_at;
      if (!at) continue;
      let bestIdx = -1;
      let bestDelta = Number.POSITIVE_INFINITY;
      marked.forEach((p, i) => {
        const d = Math.abs(new Date(p.ts).getTime() - new Date(at).getTime());
        if (d < bestDelta) {
          bestDelta = d;
          bestIdx = i;
        }
      });
      if (bestIdx >= 0 && marked[bestIdx].power_w != null) marked[bestIdx].cleaning_mark = marked[bestIdx].power_w;
    }
    return marked;
  }, [merged, cleaning.data]);

  const classSeries = React.useMemo(() => {
    const items = (predictions.data?.items ?? [])
      .map((p) => ({ ts: p.captured_at, cls: CLASS_INDEX[p.predicted_class] ?? -1, name: p.predicted_label }))
      .filter((p) => p.cls >= 0)
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    return items;
  }, [predictions.data]);

  const missing = merged.filter((p) => p.power_w === null).length;
  const source = telemetry.data?.source ?? "simulated";
  // Demo site runs on a fixed solar time (UTC+5:30, sunrise ~05:36, sunset ~18:36).
  const atSiteNight = React.useMemo(() => {
    if (!merged.length) return false;
    const last = new Date(merged[merged.length - 1].ts).getTime();
    if (Number.isNaN(last)) return false;
    const d = new Date(last + 5.5 * 3_600_000);
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    return hour < 5.6 || hour > 18.6;
  }, [merged]);

  async function onExport() {
    if (!selectedDeviceId) return;
    setExporting(true);
    try {
      await api.csvDownload("/api/export/telemetry", `telemetry-${selectedDeviceId}-${range}.csv`, {
        device_id: selectedDeviceId,
        range,
        from: params.from,
        to: params.to,
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const rangeLabel = RANGE_OPTIONS.find((r) => r.value === range)?.label ?? "";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Live Monitoring"
        description="Real-time and historical PV telemetry with explicit data-source labelling and honest handling of missing readings."
        tooltip={
          <>
            Charts never interpolate across gaps: a break in the line means no measurement exists for that
            period. Down-sampling may be applied on long ranges — the indicator below states when it was.
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void telemetry.reload()} disabled={!selectedDeviceId}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void onExport()} disabled={exporting || !selectedDeviceId}>
              <Download className="h-3.5 w-3.5" /> {exporting ? "Exporting…" : "Export CSV"}
            </Button>
          </>
        }
      />

      {status?.demo_mode && (
        <InfoBanner message="DEMO MODE: telemetry below is simulated by the built-in demo simulator (source badge: SIMULATED). It is not measured by hardware." />
      )}

      {/* Range controls */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pt-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="flex items-center gap-2">
              <Label
                htmlFor="range"
                className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-slate-500"
              >
                Time range
              </Label>
              <Select
                id="range"
                ariaLabel="Time range"
                value={range}
                onValueChange={(v) => setRange(v as RangeKey)}
                options={RANGE_OPTIONS}
                className="h-9 w-[184px] max-w-[200px] rounded-lg border-slate-200 px-3 text-[13px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300"
              />
            </div>

            {range === "custom" && (
              <>
                <div className="flex items-center gap-2">
                  <Label htmlFor="from" className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    From
                  </Label>
                  <Input
                    id="from"
                    type="datetime-local"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className="h-9 w-[200px] rounded-lg border-slate-200 text-[13px] shadow-sm"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="to" className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    To
                  </Label>
                  <Input
                    id="to"
                    type="datetime-local"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    className="h-9 w-[200px] rounded-lg border-slate-200 text-[13px] shadow-sm"
                  />
                </div>
              </>
            )}

            <div className="flex items-center gap-1.5">
              <SourceBadge source={source} />
              {telemetry.data?.downsampled && (
                <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-amber-700">
                  Down-sampled
                </span>
              )}
              <span
                title="Telemetry channel"
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]",
                  wsState === "live" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600",
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    wsState === "live"
                      ? "animate-pulse bg-emerald-500"
                      : wsState === "connecting"
                        ? "animate-pulse bg-slate-400"
                        : "bg-slate-400",
                  )}
                />
                {wsState === "live" ? "Live stream" : wsState === "connecting" ? "Connecting" : "Polling"}
              </span>
            </div>
          </div>

          <div className="flex flex-col items-end leading-tight sm:border-l sm:border-slate-200/80 sm:pl-5">
            <p className="text-xs">
              <span className="font-bold text-slate-700">
                {merged.length} sample{merged.length === 1 ? "" : "s"}
              </span>
              <span className="text-slate-400"> · {rangeLabel}</span>
            </p>
            <p className="mt-0.5 text-[10px] text-slate-400">
              {merged.length ? `latest ${formatDateTime(merged[merged.length - 1].ts)}` : "no samples in range"}
            </p>
          </div>
        </CardContent>
      </Card>

      {telemetry.error && !telemetry.data && (
        <ErrorState message={telemetry.error} onRetry={telemetry.reload} />
      )}

      {telemetry.loading && !telemetry.data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : (
        <StatTiles points={merged} source={source} />
      )}

      {missing > 0 && (
        <InfoBanner
          message={`${missing} sample${missing === 1 ? "" : "s"} in this range have no recorded measurement. Gaps are shown as breaks in the curves and are never filled or interpolated.${
            atSiteNight
              ? " Nighttime at the site (sunset ~6:36 PM local solar time): the inverter reports no AC output until dawn, so power/voltage/current curves are legitimately empty."
              : ""
          }`}
        />
      )}

      {merged.length === 0 && !telemetry.loading && !telemetry.error && (
        <EmptyState
          icon={<Activity className="h-5 w-5" />}
          title="No readings in the selected range"
          message="Pick a wider range, or start the backend in demo mode so the simulator generates history."
        />
      )}

      {merged.length > 0 && (
        <>
          <ChartCard
            title="PV power versus time"
            description="Cleaning cycles are marked on the timeline where a sample exists close to the event"
            legend={
              <>
                <LegendDot color={SERIES.power} label="PV power (W)" />
                <LegendDot color="#0284c7" label="cleaning event" />
              </>
            }
            right={<SourceBadge source={source} />}
          >
            <MultiLineChart
              data={powerData}
              height={280}
              yUnit="W"
              series={[{ key: "power_w", color: SERIES.power, name: "PV power", unit: "W" }]}
              extra={
                <>
                  <Line
                    dataKey="cleaning_mark"
                    name="cleaning event"
                    stroke="none"
                    dot={{ r: 5, fill: "#0284c7", stroke: "#fff", strokeWidth: 2 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  <Tooltip content={<ChartTooltipContent />} isAnimationActive={false} />
                </>
              }
            />
          </ChartCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Voltage versus time"
              description="DC string voltage (V)"
              right={<SourceBadge source={source} />}
            >
              <MultiLineChart
                data={merged}
                height={230}
                yUnit="V"
                series={[{ key: "voltage_v", color: SERIES.voltage, name: "Voltage", unit: "V" }]}
              />
            </ChartCard>

            <ChartCard
              title="Current versus time"
              description="DC string current (A)"
              right={<SourceBadge source={source} />}
            >
              <MultiLineChart
                data={merged}
                height={230}
                yUnit="A"
                series={[{ key: "current_a", color: SERIES.current, name: "Current", unit: "A" }]}
              />
            </ChartCard>

            <ChartCard
              title="Temperature and humidity"
              description={selectedDevice?.has_climate_sensor === false ? "No climate sensor configured for this device" : "Panel / ambient temperature and relative humidity"}
              legend={
                <>
                  <LegendDot color={SERIES.temp} label="Panel temp (°C)" />
                  <LegendDot color={SERIES.humidity} label="Humidity (%)" />
                </>
              }
              right={<SourceBadge source={source} />}
            >
              <MultiLineChart
                data={merged}
                height={230}
                series={[
                  { key: "panel_temp_c", color: SERIES.temp, name: "Panel temp", unit: "°C" },
                  { key: "humidity_pct", color: SERIES.humidity, name: "Humidity", unit: "%", dash: true },
                ]}
              />
            </ChartCard>

            <ChartCard
              title="Solar irradiance"
              description={
                selectedDevice && !selectedDevice.has_irradiance_sensor
                  ? "Irradiance sensor not installed — electrical decisions use reduced certainty"
                  : "Plane-of-array irradiance (W/m²)"
              }
              right={<SourceBadge source={source} />}
            >
              <MultiLineChart
                data={merged}
                height={230}
                yUnit=""
                series={[{ key: "irradiance_wm2", color: SERIES.irradiance, name: "Irradiance", unit: "W/m²" }]}
              />
            </ChartCard>

            <ChartCard
              title="Soiling classification versus time"
              description="Each point is a stored AI prediction; hover for the class name"
              right={
                predictions.data && predictions.data.items.length > 0 ? (
                  <Badge variant="secondary" size="sm">{predictions.data.items.length} predictions</Badge>
                ) : (
                  <Badge variant="outline" size="sm">no predictions</Badge>
                )
              }
            >
              {classSeries.length === 0 ? (
                <EmptyState
                  icon={<CircleDot className="h-5 w-5" />}
                  title="No classifications in this range"
                  message="Run an analysis on the AI Soiling Detection page to populate the timeline."
                />
              ) : (
                <ChartFrame height={230}>
                  <LineChart data={classSeries} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <ChartGrid />
                    <TimeAxis />
                    <YAxis
                      reversed
                      domain={[-0.5, 3.5]}
                      ticks={[0, 1, 2, 3]}
                      tickFormatter={(v: number) =>
                        ["Bird dropping", "Heavily dusty", "Lightly dusty", "Clean"][v] ?? ""
                      }
                      tick={{ fontSize: 10, fill: "#94a3b8" }}
                      tickLine={false}
                      axisLine={{ stroke: "#e2e8f0" }}
                      width={92}
                    />
                    <Tooltip
                      isAnimationActive={false}
                      content={(props) => {
                        const { active, payload, label } = props;
                        const row = payload?.[0] as { payload?: { name?: string } } | undefined;
                        if (!active || !payload || payload.length === 0) return null;
                        return (
                          <div className="rounded-md border border-navy-700 bg-navy-900 px-3 py-2 text-xs text-slate-100 shadow-lg">
                            <p className="text-[11px] font-semibold text-slate-300">{formatDateTime(String(label))}</p>
                            <p>{row?.payload?.name ?? "—"}</p>
                          </div>
                        );
                      }}
                    />
                    <Line
                      type="stepAfter"
                      dataKey="cls"
                      name="class"
                      stroke={SERIES.fault}
                      strokeWidth={1.4}
                      dot={{ r: 4, fill: "#fff", stroke: SERIES.fault, strokeWidth: 2 }}
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                  </LineChart>
                </ChartFrame>
              )}
            </ChartCard>

            <ChartCard
              title="Data quality"
              description="Explicit status of the current query"
              right={<Thermometer className="h-4 w-4 text-slate-400" />}
            >
              <dl className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <dt className="text-[11px] text-slate-500">Data source</dt>
                  <dd className="mt-1 flex items-center gap-2 font-semibold text-slate-800">
                    <SourceBadge source={source} />
                  </dd>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <dt className="text-[11px] text-slate-500">Samples / gaps</dt>
                  <dd className="mt-1 font-semibold text-slate-800">
                    {merged.length} / {missing}
                  </dd>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <dt className="text-[11px] text-slate-500">Poll interval</dt>
                  <dd className="mt-1 font-semibold text-slate-800">
                    {RANGE_POLL_MS[range] ? `${RANGE_POLL_MS[range]! / 1000} s` : "manual only"}
                  </dd>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <dt className="text-[11px] text-slate-500">Last sample</dt>
                  <dd className="mt-1 font-semibold text-slate-800">
                    {merged.length ? formatTime(merged[merged.length - 1].ts) : "—"}
                  </dd>
                </div>
                <div className="col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <dt className="text-[11px] text-slate-500">Device</dt>
                  <dd className="mt-1 font-semibold text-slate-800">
                    {selectedDevice ? `${selectedDevice.display_name} · ${selectedDevice.location || "no location"}` : "—"}
                    {selectedDevice?.simulated && (
                      <Badge variant="secondary" size="sm" className="ml-2">simulated device</Badge>
                    )}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 border-t border-slate-100 pt-2.5 text-[11px] leading-relaxed text-slate-500">
                Electrical power changes are not proof of soiling. Cloud cover, shading, temperature and
                faults produce the same signature — use the sensor-fusion decision for attribution.
              </p>
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
