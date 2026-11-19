import * as React from "react";
import {
  Camera,
  Cpu,
  Loader2,
  LogOut,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useAuth } from "@/context/AuthContext";
import { useSystem } from "@/context/SystemContext";
import { formatDateTime } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState, PageHeader, WarningBanner } from "@/components/shared/indicators";
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

function ReadOnlyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-right text-xs font-medium text-slate-800">{value}</span>
    </div>
  );
}

export default function SettingsPage() {
  const { hasRole, user, logout } = useAuth();
  const { status, selectedDevice } = useSystem();
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

  const automatic = String(value("policy")) === "automatic";
  const modelLoaded = Boolean(status?.model.available);

  function validate(): boolean {
    const errs: Record<string, string> = {};
    const num = (k: keyof AppSettings, min: number, max: number) => {
      const v = Number(value(k));
      if (!Number.isFinite(v) || v < min || v > max) errs[k as string] = `Must be between ${min} and ${max}.`;
    };
    num("min_model_confidence", 0, 1);
    num("soiling_threshold_pct", 1, 95);
    num("cleaning_cooldown_s", 60, 86400 * 7);
    num("max_cleaning_runtime_s", 10, 3600);
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
        if (["soiling_threshold_pct", "min_model_confidence", "cleaning_cooldown_s", "max_cleaning_runtime_s"].includes(k)) {
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
        <PageHeader title="Settings" description="Detection, cleaning and operating preferences" />
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
        <PageHeader title="Settings" description="Detection, cleaning and operating preferences" />
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
        description="Detection thresholds, cleaning limits, operating mode and device status."
        tooltip={
          <>
            Settings are validated on the client and on the server. Cleaning limits are applied by both the
            backend and the ESP32 firmware.
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {cfg && (
              <span className="hidden text-right text-[11px] text-slate-400 sm:block">
                last change {cfg.updated_at ? formatDateTime(cfg.updated_at) : "—"}
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

      <Section
        icon={<UserRound className="h-4 w-4" />}
        title="Account & profile"
        description="The account signed in on this device"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-solar-500 to-solar-700 text-sm font-semibold text-white"
            >
              {(user?.full_name ?? user?.username ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold text-slate-800">
                {user?.full_name ?? user?.username}
              </p>
              <p className="truncate text-xs text-slate-500">@{user?.username}</p>
            </div>
            <Badge variant="dark" size="sm">
              <ShieldCheck className="h-3 w-3" /> {user?.role}
            </Badge>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={logout}
            className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </Button>
        </div>
        <p className="text-[11px] text-slate-400">
          Signing out clears the stored session on this browser and returns to the sign-in screen.
        </p>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          icon={<SlidersHorizontal className="h-4 w-4" />}
          title="AI dust detection"
          description="Thresholds used by the CNN classification and the dust decision"
        >
          <NumberField
            id="min_model_confidence"
            label="CNN confidence threshold"
            hint="Predictions below this probability are ignored by the cleaning decision."
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
            label="Dust detection threshold"
            hint="Estimated power loss (%) that counts as significant soiling when the camera agrees."
            value={String(value("soiling_threshold_pct"))}
            min={1}
            max={95}
            step={0.5}
            unit="%"
            disabled={!isAdmin}
            error={!!validationErrors.soiling_threshold_pct}
            onChange={(v) => set("soiling_threshold_pct", v)}
          />
          <p className="text-[11px] leading-relaxed text-slate-500">
            Current model: {modelLoaded ? `${status?.model.name} v${status?.model.version}` : "no trained CNN loaded — a clearly labelled demo rule is used instead"}.
          </p>
        </Section>

        <Section
          icon={<Wrench className="h-4 w-4" />}
          title="Automatic cleaning"
          description="What the system may do when dust is detected"
        >
          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
            <div>
              <Label className="text-xs">Automatic cleaning</Label>
              <p className="text-[11px] text-slate-500">
                {automatic
                  ? "On: a recommended cycle starts without operator confirmation."
                  : "Off: every cycle needs manual approval from the cleaning page."}
              </p>
            </div>
            <Switch
              checked={automatic}
              disabled={!isAdmin}
              onCheckedChange={(v) => set("policy", v ? "automatic" : "manual_approval")}
            />
          </div>
          <NumberField
            id="cleaning_cooldown_s"
            label="Cleaning cooldown"
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
            label="Motor operating duration"
            hint="Hard limit for the wiper motor; the firmware stops the motor by itself after this time."
            value={String(value("max_cleaning_runtime_s"))}
            min={10}
            max={3600}
            step={10}
            unit="s"
            disabled={!isAdmin}
            error={!!validationErrors.max_cleaning_runtime_s}
            onChange={(v) => set("max_cleaning_runtime_s", v)}
          />
        </Section>

        <Section
          icon={<Cpu className="h-4 w-4" />}
          title="System"
          description="Operating mode and the hardware this dashboard is connected to"
        >
          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
            <div>
              <Label className="text-xs">Demo mode</Label>
              <p className="text-[11px] text-slate-500">
                Simulated readings only; never energises hardware. Leave off when the ESP32 prototype is connected.
              </p>
            </div>
            <Switch
              checked={Boolean(value("demo_mode"))}
              disabled={!isAdmin}
              onCheckedChange={(v) => set("demo_mode", v)}
            />
          </div>
          <ReadOnlyRow label="Camera source" value={<span className="inline-flex items-center gap-1.5"><Camera className="h-3.5 w-3.5 text-slate-400" /> Phone camera (IP Webcam)</span>} />
          <ReadOnlyRow
            label="Controller"
            value={selectedDevice?.simulated ? "Demo simulator" : `ESP32${selectedDevice?.firmware_version ? ` · ${selectedDevice.firmware_version}` : ""}`}
          />
          <ReadOnlyRow
            label="Electrical sensor"
            value={selectedDevice?.simulated ? "Simulated INA219" : "INA219 (I²C)"}
          />
          <ReadOnlyRow label="Cleaning actuator" value="12 V DC motor wiper" />
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
