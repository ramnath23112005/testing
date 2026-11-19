import { Link } from "react-router-dom";
import { Camera, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useSystem } from "@/context/SystemContext";
import { formatDateTime, formatNumber, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ErrorState,
  InfoBanner,
  OperatingModeBadge,
  PageHeader,
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
    </div>
  );
}

export default function OverviewPage() {
  const { status, statusError, refreshStatus } = useSystem();
  const model = status?.model;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Single-panel snapshot of electrical output, visual soiling state and cleaning-system readiness."
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
    </div>
  );
}
