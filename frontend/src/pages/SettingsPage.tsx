import * as React from "react";
import {
  Bell,
  Building2,
  Database,
  Loader2,
  Lock,
  Save,
  ShieldAlert,
  SlidersHorizontal,
  Users,
  Waves,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useAuth } from "@/context/AuthContext";
import { formatDateTime } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/progress";
import { ErrorState, InfoBanner, PageHeader, WarningBanner } from "@/components/shared/indicators";
import type { AppSettings, SettingsWarning } from "@/lib/types";

type Draft = Partial<Record<keyof AppSettings, string | number | boolean>>;

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="text-solar-600">{icon}</span> {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  disabled,
  error,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number | string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  error?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[1fr_150px] sm:items-center">
      <div>
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{hint}</p>
      </div>
      <div className="relative">
        <Input
          id={id}
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={error ? "border-red-400 focus-visible:border-red-500" : ""}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        {unit && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-slate-400">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { hasRole, user } = useAuth();
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<Draft>({});
  const [saving, setSaving] = React.useState(false);
  const [serverWarnings, setServerWarnings] = React.useState<SettingsWarning[]>([]);
  const [validationErrors, setValidationErrors] = React.useState<Record<string, string>>({});

  const loaded = useAsync((signal) => api.settings({ signal }), []);
  const cfg = loaded.data?.settings;
  const isAdmin = hasRole("admin");

  const value = <K extends keyof AppSettings>(key: K): string | number | boolean | null => {
    const d = draft[key];
    if (d !== undefined) return d as string | number | boolean;
    return (cfg?.[key] ?? "") as string | number | boolean | null;
  };

  const set = (key: keyof AppSettings, v: string | number | boolean) =>
    setDraft((d) => ({ ...d, [key]: v }));

  function validate(): boolean {
    const errs: Record<string, string> = {};
    const num = (k: keyof AppSettings, min: number, max: number) => {
      const v = Number(value(k));
      if (!Number.isFinite(v) || v < min || v > max) errs[k as string] = `Must be between ${min} and ${max}.`;
    };
    num("soiling_threshold_pct", 1, 95);
    num("max_power_loss_pct", 1, 95);
    num("min_model_confidence", 0, 1);
    num("sensor_freshness_s", 5, 86400);
    num("cleaning_cooldown_s", 60, 86400 * 7);
    num("max_cleaning_runtime_s", 10, 3600);
    num("min_interval_s", 60, 86400);
    num("data_retention_days", 1, 3650);
    num("mqtt_port", 1, 65535);
    setValidationErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function save() {
    if (!validate()) {
      toast({ title: "Fix validation errors", description: "Some values are outside the permitted range.", variant: "error" });
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(draft)) {
        if (v === "") continue;
        if (["soiling_threshold_pct", "max_power_loss_pct", "min_model_confidence", "sensor_freshness_s", "cleaning_cooldown_s", "max_cleaning_runtime_s", "min_interval_s", "data_retention_days", "mqtt_port", "reference_power_w"].includes(k)) {
          body[k] = v === null ? null : Number(v);
        } else {
          body[k] = v;
        }
      }
      if (Object.keys(body).length === 0) {
        toast({ title: "Nothing to save", description: "Change a value first.", variant: "warning" });
        setSaving(false);
        return;
      }
      const res = await api.updateSettings(body);
      setServerWarnings(res.warnings);
      setDraft({});
      loaded.reload();
      toast({
        title: "Settings saved",
        description: res.warnings.length > 0 ? `${res.warnings.length} safety warning(s) apply.` : "Configuration updated.",
        variant: res.warnings.length > 0 ? "warning" : "success",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      if (msg.includes(":")) {
        const map: Record<string, string> = {};
        msg.split(";").forEach((part) => {
          const [f, m] = part.split(":");
          if (f && m) map[f.trim()] = m.trim();
        });
        setValidationErrors(map);
      }
      toast({ title: "Save failed", description: msg, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  if (loaded.loading && !cfg) {
    return (
      <div className="space-y-4">
        <PageHeader title="Settings" description="System configuration" />
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (loaded.error && !cfg) {
    return (
      <div className="space-y-4">
        <PageHeader title="Settings" description="System configuration" />
        <ErrorState message={loaded.error} onRetry={loaded.reload} />
      </div>
    );
  }

  const warnings = [...(loaded.data?.warnings ?? []), ...serverWarnings];
  const dirty = Object.keys(draft).length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="Classification thresholds, reference-power method, cleaning safety limits, notifications and communications."
        tooltip={
          <>
            Settings are validated on both the client and the server. Unsafe values are accepted only with an
            explicit warning so that expert operators can still configure unusual deployments.
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {cfg && (
              <span className="hidden text-right text-[11px] text-slate-400 sm:block">
                <span className="block">last change {cfg.updated_at ? formatDateTime(cfg.updated_at) : "—"}</span>
                <span className="block">by {cfg.updated_by ?? "system"}</span>
              </span>
            )}
            <Button size="sm" onClick={() => void save()} disabled={!isAdmin || saving || !dirty}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save changes
            </Button>
          </div>
        }
      />

      {!isAdmin && (
        <WarningBanner message={`Signed in as ${user?.role}: settings are read-only. Admin role is required to change configuration.`} />
      )}

      {warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((w, i) => (
            <WarningBanner key={`${w.field}-${i}`} message={`${w.field}: ${w.message}`} />
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          icon={<SlidersHorizontal className="h-4 w-4" />}
          title="Classification & thresholds"
          description="How confident and how severe a prediction must be before it influences decisions"
        >
          <NumberField
            id="min_model_confidence"
            label="Minimum model confidence"
            hint="Predictions below this probability are ignored by the decision engine."
            value={String(value("min_model_confidence"))}
            min={0}
            max={1}
            step={0.05}
            disabled={!isAdmin}
            error={!!validationErrors.min_model_confidence}
            onChange={(v) => set("min_model_confidence", v)}
          />
          <NumberField
            id="soiling_threshold_pct"
            label="Soiling threshold"
            hint="Normalised power loss (%) at which cleaning becomes recommended when the visual channel agrees."
            value={String(value("soiling_threshold_pct"))}
            min={1}
            max={95}
            step={0.5}
            unit="%"
            disabled={!isAdmin}
            error={!!validationErrors.soiling_threshold_pct}
            onChange={(v) => set("soiling_threshold_pct", v)}
          />
          <NumberField
            id="max_power_loss_pct"
            label="Maximum permitted power loss"
            hint="Beyond this cap the engine reports a possible fault instead of attributing the loss to dust."
            value={String(value("max_power_loss_pct"))}
            min={1}
            max={95}
            step={1}
            unit="%"
            disabled={!isAdmin}
            error={!!validationErrors.max_power_loss_pct}
            onChange={(v) => set("max_power_loss_pct", v)}
          />
          <Separator />
          <div className="grid gap-1.5 sm:grid-cols-[1fr_220px] sm:items-center">
            <div>
              <Label className="text-xs">Reference-power method</Label>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                Baseline used to normalise measured power before computing loss.
              </p>
            </div>
            <Select
              ariaLabel="Reference power method"
              value={String(value("reference_power_method"))}
              disabled={!isAdmin}
              onValueChange={(v) => set("reference_power_method", v)}
              options={[
                { value: "rolling_peak", label: "Rolling peak (7 days)" },
                { value: "fixed_rated", label: "Rated power (fixed)" },
                { value: "manual", label: "Manual value" },
              ]}
            />
          </div>
          {value("reference_power_method") === "manual" && (
            <NumberField
              id="reference_power_w"
              label="Manual reference power"
              hint="Absolute reference in watts when the manual method is selected."
              value={String(value("reference_power_w") || "")}
              min={1}
              step={10}
              unit="W"
              disabled={!isAdmin}
              onChange={(v) => set("reference_power_w", v)}
            />
          )}
        </Section>

        <Section
          icon={<ShieldAlert className="h-4 w-4" />}
          title="Cleaning safety"
          description="Limits that bound every actuator command"
        >
          <NumberField
            id="sensor_freshness_s"
            label="Sensor freshness timeout"
            hint="Readings older than this are considered stale and block automatic decisions."
            value={String(value("sensor_freshness_s"))}
            min={5}
            max={86400}
            step={5}
            unit="s"
            disabled={!isAdmin}
            error={!!validationErrors.sensor_freshness_s}
            onChange={(v) => set("sensor_freshness_s", v)}
          />
          <NumberField
            id="cleaning_cooldown_s"
            label="Cooldown between cycles"
            hint="Minimum time between two cleaning cycles."
            value={String(value("cleaning_cooldown_s"))}
            min={60}
            step={60}
            unit="s"
            disabled={!isAdmin}
            error={!!validationErrors.cleaning_cooldown_s}
            onChange={(v) => set("cleaning_cooldown_s", v)}
          />
          <NumberField
            id="max_cleaning_runtime_s"
            label="Maximum cleaning runtime"
            hint="Hard watchdog: the device must stop by itself after this duration."
            value={String(value("max_cleaning_runtime_s"))}
            min={10}
            max={3600}
            step={10}
            unit="s"
            disabled={!isAdmin}
            error={!!validationErrors.max_cleaning_runtime_s}
            onChange={(v) => set("max_cleaning_runtime_s", v)}
          />
          <NumberField
            id="min_interval_s"
            label="Minimum interval between cycles"
            hint="Scheduling lower bound, independent of soiling conditions."
            value={String(value("min_interval_s"))}
            min={60}
            step={300}
            unit="s"
            disabled={!isAdmin}
            error={!!validationErrors.min_interval_s}
            onChange={(v) => set("min_interval_s", v)}
          />
        </Section>

        <Section
          icon={<Waves className="h-4 w-4" />}
          title="Cleaning policy"
          description="What the system is allowed to do when a recommendation is produced"
        >
          <div className="grid gap-1.5 sm:grid-cols-[1fr_240px] sm:items-center">
            <div>
              <Label className="text-xs">Policy mode</Label>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                Default is Monitoring only. Automatic mode starts hardware without operator confirmation.
              </p>
            </div>
            <Select
              ariaLabel="Cleaning policy"
              value={String(value("policy"))}
              disabled={!isAdmin}
              onValueChange={(v) => set("policy", v)}
              options={[
                { value: "monitoring_only", label: "Monitoring only (default)" },
                { value: "recommendation_only", label: "Recommendation only" },
                { value: "manual_approval", label: "Manual approval required" },
                { value: "automatic", label: "Automatic cleaning enabled" },
              ]}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
            <div>
              <Label className="text-xs">Scheduled fallback cleaning</Label>
              <p className="text-[11px] text-slate-500">Optional time-based cycle when sensors are unavailable</p>
            </div>
            <Switch
              checked={Boolean(value("schedule_enabled"))}
              disabled={!isAdmin}
              onCheckedChange={(v) => set("schedule_enabled", v)}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
            <div>
              <Label className="text-xs">Demo mode</Label>
              <p className="text-[11px] text-slate-500">Simulated telemetry and actuation only; never energises hardware</p>
            </div>
            <Switch
              checked={Boolean(value("demo_mode"))}
              disabled={!isAdmin}
              onCheckedChange={(v) => set("demo_mode", v)}
            />
          </div>
        </Section>

        <Section
          icon={<Bell className="h-4 w-4" />}
          title="Notifications"
          description="Alert delivery preferences (email requires SMTP configuration on the server)"
        >
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
            <div>
              <Label className="text-xs">Email notifications</Label>
              <p className="text-[11px] text-slate-500">Send alerts via SMTP (credentials stay server-side)</p>
            </div>
            <Switch
              checked={Boolean(value("notify_email_enabled"))}
              disabled={!isAdmin}
              onCheckedChange={(v) => set("notify_email_enabled", v)}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
            <div>
              <Label className="text-xs">Critical alerts only</Label>
              <p className="text-[11px] text-slate-500">Suppress informational and warning notifications</p>
            </div>
            <Switch
              checked={Boolean(value("notify_critical_only"))}
              disabled={!isAdmin}
              onCheckedChange={(v) => set("notify_critical_only", v)}
            />
          </div>
          {!Boolean(value("notify_email_enabled")) && (
            <InfoBanner message="Email delivery is disabled. Alerts remain available in the in-app notification centre." />
          )}
        </Section>

        <Section
          icon={<Building2 className="h-4 w-4" />}
          title="Device communication"
          description="MQTT broker used for telemetry and actuator commands"
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_110px]">
            <div>
              <Label htmlFor="mqtt-host" className="text-xs">
                MQTT host
              </Label>
              <Input
                id="mqtt-host"
                value={String(value("mqtt_host"))}
                disabled={!isAdmin}
                placeholder="broker.local"
                onChange={(e) => set("mqtt_host", e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="mqtt-port" className="text-xs">
                Port
              </Label>
              <Input
                id="mqtt-port"
                type="number"
                value={String(value("mqtt_port"))}
                disabled={!isAdmin}
                onChange={(e) => set("mqtt_port", e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="mqtt-prefix" className="text-xs">
              Topic prefix
            </Label>
            <Input
              id="mqtt-prefix"
              value={String(value("mqtt_topic_prefix"))}
              disabled={!isAdmin}
              onChange={(e) => set("mqtt_topic_prefix", e.target.value)}
              className="mt-1"
            />
          </div>
          <p className="text-[11px] leading-relaxed text-slate-500">
            Topics follow <span className="font-mono">&lt;prefix&gt;/telemetry/&lt;device_id&gt;</span> and{" "}
            <span className="font-mono">&lt;prefix&gt;/command/&lt;device_id&gt;</span>. Credentials are supplied
            through environment variables and are never sent to the browser.
          </p>
        </Section>

        <Section
          icon={<Database className="h-4 w-4" />}
          title="Data retention"
          description="How long telemetry, images and events are kept"
        >
          <NumberField
            id="data_retention_days"
            label="Retention period"
            hint="Rows older than this may be pruned by the maintenance job."
            value={String(value("data_retention_days"))}
            min={1}
            max={3650}
            step={1}
            unit="days"
            disabled={!isAdmin}
            error={!!validationErrors.data_retention_days}
            onChange={(v) => set("data_retention_days", v)}
          />
          <InfoBanner message="Images are stored on disk (or object storage) and referenced by the database; large binaries are never embedded in telemetry rows." />
        </Section>

        <Section
          icon={<Users className="h-4 w-4" />}
          title="User access roles"
          description="Role model enforced by the backend on every privileged endpoint"
        >
          <ul className="space-y-2 text-xs">
            <li className="flex items-start gap-2">
              <Badge variant="dark" size="sm">admin</Badge>
              <span className="text-slate-600">Full control: devices, settings, cleaning, user-facing configuration.</span>
            </li>
            <li className="flex items-start gap-2">
              <Badge variant="info" size="sm">operator</Badge>
              <span className="text-slate-600">Start/stop cleaning, run analyses, confirm ground-truth labels.</span>
            </li>
            <li className="flex items-start gap-2">
              <Badge variant="secondary" size="sm">viewer</Badge>
              <span className="text-slate-600">Read-only access to dashboards, analytics and events.</span>
            </li>
          </ul>
          <Separator />
          <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] leading-relaxed text-slate-600">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            Passwords are stored as salted PBKDF2-SHA256 hashes. Authentication tokens are signed JWTs with an
            expiry. Device credentials stay in server-side environment variables.
          </div>
        </Section>
      </div>

      {dirty && !isAdmin && (
        <WarningBanner message="Unsaved changes cannot be saved with your current role." />
      )}
      {dirty && isAdmin && (
        <div className="sticky bottom-4 z-10 mx-auto w-fit rounded-full border border-solar-300 bg-solar-600 px-4 py-2 text-xs font-medium text-white shadow-lg">
          {Object.keys(draft).length} unsaved change{Object.keys(draft).length === 1 ? "" : "s"} ·{" "}
          <button type="button" className="underline" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save now"}
          </button>
        </div>
      )}
    </div>
  );
}
