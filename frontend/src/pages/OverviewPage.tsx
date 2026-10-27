import * as React from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Camera,
  CheckCircle2,
  Cpu,
  Droplets,
  Image as ImageIcon,
  Info,
  PlugZap,
  RefreshCw,
  Sparkles,
  SunMedium,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useSystem } from "@/context/SystemContext";
import { cn, formatDateTime, formatNumber, relativeTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  ClassBadge,
  EmptyState,
  ErrorState,
  InfoBanner,
  KpiValue,
  OperatingModeBadge,
  PageHeader,
  SourceBadge,
  WarningBanner,
} from "@/components/shared/indicators";
import { MetricCard } from "@/components/shared/MetricCard";

function DemoNotice() {
  const { status } = useSystem();
  if (!status?.demo_mode) return null;
  return (
    <InfoBanner message="DEMO MODE is active: every electrical reading shown below is simulated by the built-in demo simulator — no hardware is connected. Values are labelled with their data source." />
  );
}

function MetricRow() {
  const { selectedDeviceId, status } = useSystem();
  const overview = useAsync(
    (signal) => api.overview(selectedDeviceId ?? undefined, { signal }),
    [selectedDeviceId],
    { pollMs: 15_000 },
  );
  const spark = useAsync(
    (signal) =>
      selectedDeviceId
        ? api.telemetry(selectedDeviceId, { range: "24h", limit: 480 }, { signal })
        : Promise.reject(new Error("No device selected")),
    [selectedDeviceId],
    { pollMs: 60_000 },
  );

  if (overview.loading && !overview.data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[132px] rounded-xl" />
        ))}
      </div>
    );
  }
  if (overview.error && !overview.data) {
    return <ErrorState message={overview.error} onRetry={overview.reload} />;
  }

  const m = overview.data?.metrics;
  const rec = overview.data?.recovery;
  const powerSpark = (spark.data?.points ?? [])
    .filter((p) => p.power_w !== null)
    .map((p) => ({ ts: p.ts, power_w: p.power_w }));

  const source = m?.source ?? "simulated";

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="PV voltage"
        value={m?.voltage_v != null ? formatNumber(m.voltage_v, 1) : "—"}
        unit="V"
        source={m?.voltage_v != null ? source : "none"}
        tooltip="DC terminal voltage of the PV string measured by the electrical sensor (INA219-class device)."
        spark={{ data: (spark.data?.points ?? []).map((p) => ({ ts: p.ts, v: p.voltage_v })).filter((p) => p.v != null), dataKey: "v", color: "#0284c7" }}
        footer={m?.voltage_v == null ? "Waiting for a valid reading" : "DC string voltage"}
      />

      <MetricCard
        label="PV current"
        value={m?.current_a != null ? formatNumber(m.current_a, 2) : "—"}
        unit="A"
        source={m?.current_a != null ? source : "none"}
        tooltip="DC current delivered by the PV string. It scales with irradiance and decreases with soiling, temperature and faults."
        spark={{ data: (spark.data?.points ?? []).map((p) => ({ ts: p.ts, v: p.current_a })).filter((p) => p.v != null), dataKey: "v", color: "#7c3aed" }}
        footer="Scales with irradiance"
      />

      <MetricCard
        label="PV power"
        value={m?.power_w != null ? formatNumber(m.power_w, 0) : "—"}
        unit="W"
        source={m?.power_w != null ? source : "none"}
        delta={m?.prev_power_w != null && m?.power_w != null && m.prev_power_w !== 0
          ? ((m.power_w - m.prev_power_w) / Math.abs(m.prev_power_w)) * 100
          : null}
        deltaLabel="vs previous hour"
        tooltip="Instantaneous DC power (V × I). A drop alone does not prove soiling — check the sensor-fusion decision for normalised evidence."
        spark={{ data: powerSpark, dataKey: "power_w", color: "#129257" }}
        footer="Not a direct dust measurement"
      />

      <MetricCard
        label="Energy today"
        value={
          m?.energy_today_wh != null
            ? m.energy_today_wh >= 1000
              ? formatNumber(m.energy_today_wh / 1000, 2)
              : formatNumber(m.energy_today_wh, 0)
            : "—"
        }
        unit={m?.energy_today_wh != null && m.energy_today_wh >= 1000 ? "kWh" : "Wh"}
        source={m?.energy_today_wh != null ? source : "none"}
        delta={m?.prev_energy_wh != null && m?.energy_today_wh != null && m.prev_energy_wh !== 0
          ? ((m.energy_today_wh - m.prev_energy_wh) / Math.abs(m.prev_energy_wh)) * 100
          : null}
        deltaLabel="vs same time yesterday"
        tooltip="Estimated daily energy obtained by integrating the sampled power readings since local midnight. Sparse sampling introduces estimation error."
        footer="Integrates sampled power (estimated)"
      />

      <MetricCard
        label="Soiling classification"
        value={m?.soiling_label ?? "—"}
        source={m?.soiling_class ? (m.simulated ? "demo" : "measured") : "none"}
        tooltip="Latest image classification from the AI pipeline. Confidence and model version are shown on the detection page."
        delta={undefined}
        footer={
          m?.soiling_confidence != null
            ? `Confidence ${formatNumber(m.soiling_confidence * 100, 0)}%`
            : "No classification yet"
        }
      />

      <MetricCard
        label="Estimated soiling severity"
        value={m?.soiling_severity_pct != null ? formatNumber(m.soiling_severity_pct, 1) : "—"}
        unit="%"
        tone={m?.soiling_severity_pct != null && m.soiling_severity_pct > 12 ? "danger" : m?.soiling_severity_pct != null && m.soiling_severity_pct > 5 ? "warning" : "default"}
        source="estimated"
        tooltip="Estimated severity derived from the visual class plus the normalised power-loss estimate. It is an estimate, not a direct dust measurement."
        footer="Estimate — visual class + electrical loss"
      />

      <MetricCard
        label="Last successful cleaning"
        value={m?.last_cleaning_at ? relativeTime(m.last_cleaning_at) : "never"}
        source="none"
        tooltip="Timestamp of the most recent cleaning cycle that completed successfully."
        footer={m?.last_cleaning_at ? formatDateTime(m.last_cleaning_at) : "No cycle recorded"}
      />

      <MetricCard
        label="System status"
        value={<OperatingModeBadge mode={m?.operating_mode ?? status?.operating_mode ?? "HARDWARE OFFLINE"} />}
        source="none"
        tooltip="Overall operating mode computed by the backend from device heartbeats, model availability and active faults."
        footer={
          status?.hardware_connected
            ? "Heartbeat verified by backend"
            : status?.demo_mode
              ? "Simulated device — no heartbeat"
              : "No verified device heartbeat"
        }
      />

      {rec && (
        <div className="sm:col-span-2 xl:col-span-4">
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles className="h-4 w-4 text-solar-600" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
                Energy recovery (last cleaning)
              </span>
              <Badge variant={rec.measured ? "success" : "secondary"} size="sm">
                {rec.measured ? "measured window" : "estimate"}
              </Badge>
              <span className="ml-auto text-[11px] text-slate-400">Source: cleaning outcome evaluation</span>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <div>
                <p className="text-[11px] text-slate-500">Power before cleaning</p>
                <KpiValue value={rec.power_before_w != null ? formatNumber(rec.power_before_w, 0) : "—"} unit="W" size="sm" />
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Power after cleaning</p>
                <KpiValue value={rec.power_after_w != null ? formatNumber(rec.power_after_w, 0) : "—"} unit="W" size="sm" />
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Power change</p>
                <KpiValue
                  value={
                    rec.delta_pct != null ? (
                      <span className={rec.delta_pct >= 0 ? "text-emerald-600" : "text-red-600"}>
                        {rec.delta_pct >= 0 ? "+" : ""}
                        {formatNumber(rec.delta_pct, 1)}
                      </span>
                    ) : (
                      "—"
                    )
                  }
                  unit="%"
                  size="sm"
                />
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Recovered energy vs cleaning use</p>
                <KpiValue
                  value={
                    rec.recovered_energy_wh != null ? formatNumber(rec.recovered_energy_wh, 0) : "—"
                  }
                  unit={
                    rec.cleaning_energy_wh != null
                      ? `Wh (used ${formatNumber(rec.cleaning_energy_wh, 0)} Wh)`
                      : "Wh"
                  }
                  size="sm"
                />
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              {rec.note}
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}

function ConditionCard() {
  const { selectedDeviceId } = useSystem();
  const overview = useAsync(
    (signal) => api.overview(selectedDeviceId ?? undefined, { signal }),
    [selectedDeviceId],
    { pollMs: 20_000 },
  );
  const c = overview.data?.condition;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <SunMedium className="h-4 w-4 text-solar-600" /> Solar panel condition
          </CardTitle>
          <CardDescription>Latest captured image and its classification</CardDescription>
        </div>
        {c?.source && <SourceBadge source={c.source} />}
      </CardHeader>
      <CardContent>
        {overview.loading && !c ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !c || !c.image_url ? (
          <EmptyState
            icon={<ImageIcon className="h-5 w-5" />}
            title="No panel image yet"
            message="Upload or capture an image on the AI Soiling Detection page to populate the condition card."
            action={
              <Button asChild size="sm" variant="outline">
                <Link to="/detection">Open detection workspace</Link>
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
              <img
                src={c.image_url}
                alt="Latest solar panel capture"
                className="h-48 w-full object-cover sm:h-56"
                loading="lazy"
              />
              <div className="absolute left-2 top-2 flex items-center gap-1.5">
                <Badge variant={c.predicted_class === "clean" ? "success" : c.predicted_class ? "destructive" : "secondary"}>
                  {c.predicted_label ?? "Awaiting classification"}
                </Badge>
              </div>
              <div className="absolute bottom-2 right-2 rounded bg-navy-900/80 px-2 py-1 text-[10px] text-slate-200">
                {formatDateTime(c.captured_at)}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-[11px] text-slate-500">Predicted condition</p>
                <p className="mt-0.5 font-semibold text-slate-800">{c.predicted_label ?? "—"}</p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Model confidence</p>
                <div className="mt-1 flex items-center gap-2">
                  <Progress value={(c.confidence ?? 0) * 100} className="h-1.5 flex-1" />
                  <span className="font-mono text-[11px] text-slate-700">
                    {c.confidence != null ? `${formatNumber(c.confidence * 100, 1)}%` : "—"}
                  </span>
                </div>
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Model version</p>
                <p className="mt-0.5 font-mono text-[11px] text-slate-700">{c.model_version ?? "—"}</p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Captured</p>
                <p className="mt-0.5 text-[11px] text-slate-700">{relativeTime(c.captured_at)}</p>
              </div>
            </div>

            {c.recommendation && (
              <div className="rounded-lg border-l-[3px] border-amber-500 bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-900/90 shadow-sm">
                <span className="font-semibold">Recommendation: </span>
                {c.recommendation}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-slate-500">Supported classes:</span>
              {["clean", "lightly_dusty", "heavily_dusty", "bird_dropping"].map((k) => (
                <ClassBadge key={k} value={k} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DecisionCard() {
  const { selectedDeviceId, status } = useSystem();
  const decision = useAsync(
    () => api.latestDecision(selectedDeviceId ?? undefined).catch(() => null),
    [selectedDeviceId],
    { pollMs: 30_000 },
  );

  const d = decision.data ?? null;
  const actionTone = (a?: string) =>
    a === "cleaning_required"
      ? { cls: "border-l-red-500 bg-red-50/70 text-red-900", icon: <AlertTriangle className="h-4 w-4 text-red-500" /> }
      : a === "cleaning_recommended"
        ? { cls: "border-l-amber-500 bg-amber-50/70 text-amber-900", icon: <AlertTriangle className="h-4 w-4 text-amber-600" /> }
        : a === "cleaning_deferred" || a === "possible_sensor_fault"
          ? { cls: "border-l-orange-500 bg-orange-50/70 text-orange-900", icon: <Info className="h-4 w-4 text-orange-600" /> }
          : a === "insufficient_data"
            ? { cls: "border-l-slate-400 bg-slate-50/80 text-slate-700", icon: <Info className="h-4 w-4 text-slate-500" /> }
            : { cls: "border-l-emerald-500 bg-emerald-50/70 text-emerald-900", icon: <CheckCircle2 className="h-4 w-4 text-emerald-600" /> };

  const tone = actionTone(d?.action);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-solar-600" /> Cleaning decision
          </CardTitle>
          <CardDescription>Visual + electrical sensor fusion</CardDescription>
        </div>
        <Badge variant="secondary" size="sm">{d?.certainty ?? "—"} certainty</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {decision.loading && !d ? (
          <Skeleton className="h-24 w-full" />
        ) : !d ? (
          <EmptyState
            title="No decision recorded yet"
            message="A decision is produced when fresh telemetry and a recent classification are both available. Open the cleaning page to evaluate now."
            action={
              <Button asChild size="sm" variant="outline">
                <Link to="/cleaning">Open cleaning control</Link>
              </Button>
            }
          />
        ) : (
          <>
            <div className={cn("flex items-start gap-2.5 rounded-lg border-l-[3px] px-3 py-2.5 shadow-sm", tone.cls)}>
              {tone.icon}
              <div className="min-w-0">
                <p className="text-sm font-semibold">{d.action_label}</p>
                <p className="mt-0.5 text-[11px] opacity-80">
                  Confidence {formatNumber(d.confidence * 100, 0)}% · policy {d.policy.replace("_", " ")} ·{" "}
                  {relativeTime(d.generated_at)}
                </p>
              </div>
            </div>

            <p className="text-xs leading-relaxed text-slate-600">{d.explanation}</p>

            <div className="space-y-1.5 border-t border-slate-100 pt-2.5">
              {d.evidence.slice(0, 4).map((e, i) => (
                <div key={i} className="flex items-start gap-2 text-[11px]">
                  <span
                    className={cn(
                      "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                      e.impact === "supports_cleaning"
                        ? "bg-emerald-500"
                        : e.impact === "against_cleaning"
                          ? "bg-slate-400"
                          : "bg-sky-500",
                    )}
                  />
                  <span className="text-slate-500">
                    <span className="font-medium text-slate-700">{e.label}:</span> {e.value}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px]">
              <span className="text-slate-400">
                {status?.demo_mode ? "Computed on simulated telemetry" : "Computed on live telemetry"}
              </span>
              <Link to="/cleaning" className="font-medium text-solar-700 hover:underline">
                Review on cleaning page →
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityCard() {
  const { selectedDeviceId, status } = useSystem();
  const overview = useAsync(
    (signal) => api.overview(selectedDeviceId ?? undefined, { signal }),
    [selectedDeviceId],
    { pollMs: 20_000 },
  );
  const a = overview.data?.activity;
  const alerts = a?.active_alerts ?? [];

  const rows: { label: string; icon: React.ReactNode; value: string }[] = [
    { label: "Last sensor update", icon: <Activity className="h-3.5 w-3.5" />, value: relativeTime(a?.last_sensor_at) },
    { label: "Last image capture", icon: <Camera className="h-3.5 w-3.5" />, value: relativeTime(a?.last_image_at) },
    { label: "Last AI inference", icon: <Cpu className="h-3.5 w-3.5" />, value: relativeTime(a?.last_inference_at) },
    { label: "Last cleaning cycle", icon: <Droplets className="h-3.5 w-3.5" />, value: relativeTime(a?.last_cleaning_at) },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugZap className="h-4 w-4 text-solar-600" /> System activity
        </CardTitle>
        <CardDescription>Heartbeats, captures, inference and cycles</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between rounded-lg bg-slate-50/80 px-3 py-2">
          <span className="text-[11px] font-medium text-slate-500">Current operating mode</span>
          <OperatingModeBadge mode={a?.operating_mode ?? status?.operating_mode ?? "HARDWARE OFFLINE"} />
        </div>

        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-500">
                <span className="text-slate-400">{r.icon}</span>
                {r.label}
              </span>
              <span className="font-medium text-slate-700">{r.value}</span>
            </li>
          ))}
        </ul>

        <div className="border-t border-slate-100 pt-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Active alerts ({alerts.length})
          </p>
          {alerts.length === 0 ? (
            <p className="text-xs text-slate-400">No active alerts.</p>
          ) : (
            <ul className="space-y-2">
              {alerts.slice(0, 4).map((al) => (
                <li
                  key={al.id}
                  className={cn(
                    "rounded-md border-l-2 px-2.5 py-1.5 text-[11px]",
                    al.severity === "critical"
                      ? "border-l-red-500 bg-red-50 text-red-800"
                      : al.severity === "warning"
                        ? "border-l-amber-500 bg-amber-50 text-amber-900"
                        : "border-l-sky-500 bg-sky-50 text-sky-900",
                  )}
                >
                  <span className="font-semibold">{al.title}</span>
                  <span className="block text-[10px] opacity-80">{al.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Button asChild variant="outline" size="sm" className="w-full">
          <Link to="/events">Open event history</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function OverviewPage() {
  const { status, statusError, refreshStatus } = useSystem();
  const model = status?.model;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Fleet-level snapshot of PV electrical output, visual soiling state and cleaning-system readiness."
        tooltip={
          <>
            Metrics combine the latest telemetry sample with the most recent image classification. Power is
            never interpreted as dust on its own — see the cleaning decision card for normalised evidence.
          </>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => void refreshStatus()}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button asChild size="sm" className="shadow-sm shadow-solar-700/30">
              <Link to="/detection">
                <Camera className="h-3.5 w-3.5" /> Analyse panel
              </Link>
            </Button>
          </>
        }
      />

      <DemoNotice />
      {statusError && <WarningBanner message={`Backend unreachable: ${statusError}`} />}
      {model && !model.available && (
        <WarningBanner message="AI MODEL UNAVAILABLE — no trained model is loaded. Classification features are disabled; a clearly labelled demo analysis can still be run from the detection page." />
      )}

      <MetricRow />

      <div className="grid gap-5 lg:grid-cols-3">
        <ConditionCard />
        <DecisionCard />
        <ActivityCard />
      </div>
    </div>
  );
}
