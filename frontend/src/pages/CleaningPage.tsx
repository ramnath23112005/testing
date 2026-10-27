import * as React from "react";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Droplet,
  Droplets,
  Gauge,
  History,
  Loader2,
  Lock,
  Play,
  Power,
  Settings2,
  ShieldAlert,
  Timer,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useAuth } from "@/context/AuthContext";
import { useSystem } from "@/context/SystemContext";
import { cn, formatDateTime, formatNumber, relativeTime } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogButtons,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  EmptyState,
  ErrorState,
  InfoBanner,
  PageHeader,
  SourceBadge,
  WarningBanner,
} from "@/components/shared/indicators";
import type { CleaningJob, Decision } from "@/lib/types";

function StatTile({
  icon,
  label,
  value,
  sub,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "default" | "ok" | "warn" | "bad";
}) {
  const toneCls =
    tone === "ok" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : tone === "bad" ? "text-red-600" : "text-slate-800";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        <span className="text-slate-400">{icon}</span>
        {label}
      </div>
      <p className={cn("mt-2 text-lg font-semibold tabular-nums", toneCls)}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

function DecisionPanel() {
  const { selectedDeviceId } = useSystem();
  const { toast } = useToast();
  const [evaluating, setEvaluating] = React.useState(false);
  const decision = useAsync(
    () => api.latestDecision(selectedDeviceId ?? undefined).catch(() => null),
    [selectedDeviceId],
    { pollMs: 30_000 },
  );

  async function evaluateNow() {
    if (!selectedDeviceId) return;
    setEvaluating(true);
    try {
      const d = await api.evaluateDecision(selectedDeviceId);
      decision.reload();
      toast({ title: "Decision evaluated", description: d.action_label, variant: "success" });
    } catch (e) {
      toast({ title: "Evaluation failed", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setEvaluating(false);
    }
  }

  const d: Decision | null = decision.data ?? null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-solar-600" /> Condition-based decision
          </CardTitle>
          <CardDescription>
            Combines the visual classification with irradiance-normalised electrical evidence
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => void evaluateNow()} disabled={evaluating}>
          {evaluating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Gauge className="h-3.5 w-3.5" />}
          Evaluate now
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {decision.loading && !d ? (
          <Skeleton className="h-24 w-full" />
        ) : !d ? (
          <EmptyState
            title="No decision yet"
            message="Press “Evaluate now” once telemetry and a classification are available."
          />
        ) : (
          <>
            <div
              className={cn(
                "rounded-lg border px-3 py-2.5",
                d.action === "cleaning_required"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : d.action === "cleaning_recommended"
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : d.action === "no_action"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-slate-200 bg-slate-50 text-slate-700",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{d.action_label}</span>
                <Badge variant="secondary" size="sm">certainty: {d.certainty}</Badge>
                <Badge variant="outline" size="sm">confidence {formatNumber(d.confidence * 100, 0)}%</Badge>
                <span className="ml-auto text-[11px] opacity-70">{relativeTime(d.generated_at)}</span>
              </div>
            </div>

            <p className="text-xs leading-relaxed text-slate-600">{d.explanation}</p>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2">Evidence</th>
                    <th className="px-3 py-2">Value</th>
                    <th className="px-3 py-2">Effect</th>
                  </tr>
                </thead>
                <tbody>
                  {d.evidence.map((e, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-1.5 font-medium text-slate-700">{e.label}</td>
                      <td className="px-3 py-1.5 text-slate-600">{e.value}</td>
                      <td className="px-3 py-1.5">
                        <Badge
                          variant={e.impact === "supports_cleaning" ? "warning" : "secondary"}
                          size="sm"
                        >
                          {e.impact.replace(/_/g, " ")}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] leading-relaxed text-slate-500">
              Inputs recorded: {Object.entries(d.inputs)
                .filter(([, v]) => v !== null && v !== undefined)
                .slice(0, 8)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(" · ")}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function CleaningPage() {
  const { selectedDeviceId, status, refreshStatus } = useSystem();
  const { hasRole } = useAuth();
  const { toast } = useToast();
  const [confirmStart, setConfirmStart] = React.useState(false);
  const [confirmStop, setConfirmStop] = React.useState(false);
  const [busy, setBusy] = React.useState<"start" | "stop" | "test" | "auto" | null>(null);
  const [settingsDraft, setSettingsDraft] = React.useState<Record<string, string | boolean>>({});
  const [savingSettings, setSavingSettings] = React.useState(false);

  const st = useAsync(
    () => api.cleaningStatus(selectedDeviceId ?? undefined),
    [selectedDeviceId],
    { pollMs: 4_000 },
  );
  const history = useAsync(
    () => api.cleaningHistory({ page_size: 12 }).catch(() => ({ items: [], total: 0, simulated: true })),
    [selectedDeviceId],
    { pollMs: 20_000 },
  );
  const settings = useAsync(() => api.settings(), [], { pollMs: null });

  const s = st.data;
  const currentJob = s?.current_job ?? null;
  const canControl = hasRole("operator", "admin");
  const jobRunning = currentJob?.status === "running" || currentJob?.status === "queued";

  const jobRuntime = React.useMemo(() => {
    if (!currentJob?.started_at) return 0;
    const start = new Date(currentJob.started_at).getTime();
    return Math.max(0, (Date.now() - start) / 1000);
  }, [currentJob, st.data]);

  async function startCleaning() {
    if (!selectedDeviceId) return;
    setBusy("start");
    try {
      const res = await api.requestCleaning(selectedDeviceId, "Manual start from cleaning dashboard");
      toast({ title: "Cleaning requested", description: res.detail, variant: "success" });
      setConfirmStart(false);
      st.reload();
      history.reload();
      refreshStatus();
    } catch (e) {
      toast({ title: "Start refused", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function stopCleaning() {
    if (!selectedDeviceId) return;
    setBusy("stop");
    try {
      const res = await api.stopCleaning(selectedDeviceId);
      toast({ title: "Stop command sent", description: res.detail, variant: "warning" });
      setConfirmStop(false);
      st.reload();
      history.reload();
      refreshStatus();
    } catch (e) {
      toast({ title: "Stop failed", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function testActuator() {
    if (!selectedDeviceId) return;
    setBusy("test");
    try {
      const res = await api.testActuator(selectedDeviceId);
      toast({ title: res.ok ? "Actuator test OK" : "Actuator test failed", description: res.detail, variant: res.ok ? "success" : "error" });
      st.reload();
    } catch (e) {
      toast({ title: "Test failed", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function toggleAuto(enabled: boolean) {
    if (!selectedDeviceId) return;
    setBusy("auto");
    try {
      await api.toggleAutoCleaning(selectedDeviceId, enabled);
      toast({
        title: enabled ? "Automatic cleaning enabled" : "Automatic cleaning disabled",
        variant: "success",
      });
      st.reload();
      refreshStatus();
    } catch (e) {
      toast({ title: "Could not change mode", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function saveInlineSettings() {
    setSavingSettings(true);
    try {
      const body: Record<string, unknown> = {};
      if (settingsDraft.soiling_threshold_pct !== undefined && settingsDraft.soiling_threshold_pct !== "")
        body.soiling_threshold_pct = Number(settingsDraft.soiling_threshold_pct);
      if (settingsDraft.cleaning_cooldown_s !== undefined && settingsDraft.cleaning_cooldown_s !== "")
        body.cleaning_cooldown_s = Number(settingsDraft.cleaning_cooldown_s);
      if (settingsDraft.max_cleaning_runtime_s !== undefined && settingsDraft.max_cleaning_runtime_s !== "")
        body.max_cleaning_runtime_s = Number(settingsDraft.max_cleaning_runtime_s);
      if (settingsDraft.policy !== undefined) body.policy = settingsDraft.policy;
      const res = await api.updateSettings(body);
      settings.reload();
      st.reload();
      toast({ title: "Settings saved", description: `${res.warnings.length} warning(s)`, variant: "success" });
      setSettingsDraft({});
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setSavingSettings(false);
    }
  }

  const startDisabled =
    !canControl ||
    !s ||
    !s.can_start ||
    jobRunning ||
    s.policy === "monitoring_only" ||
    st.error !== null;

  const startReason = !canControl
    ? "Your role does not permit actuator commands (operator or admin required)."
    : !s
      ? "Cleaning status unavailable."
      : st.error
        ? "Backend unreachable."
        : jobRunning
          ? "A cycle is already in progress."
          : s.policy === "monitoring_only"
            ? "Policy is ‘Monitoring only’: commands are disabled. Change the policy to allow cleaning."
            : !s.can_start
              ? s.cannot_start_reason ?? "Conditions not met."
              : null;

  if (st.error && !s) {
    return (
      <div className="space-y-5">
        <PageHeader title="Automatic Cleaning" description="Actuator control dashboard" />
        <ErrorState message={st.error} onRetry={st.reload} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Automatic Cleaning"
        description="Safe, auditable control of the pump / brush / wiper mechanism with interlocks, cooldown and runtime limits."
        tooltip={
          <>
            Commands require an authenticated operator, pass server-side interlock checks, run against a
            maximum runtime and only complete after the device acknowledges the resulting state.
          </>
        }
        actions={
          s && (
            <div className="flex items-center gap-2">
              <SourceBadge source={s.simulated ? "simulated" : "measured"} />
              <Badge variant={s.hardware_online ? "success" : "secondary"} size="sm">
                {s.hardware_online ? "controller online" : "controller offline"}
              </Badge>
            </div>
          )
        }
      />

      {status?.demo_mode && (
        <InfoBanner message="DEMO MODE: cleaning commands operate a simulated actuator only — no pump, valve or motor is ever energised by this deployment." />
      )}
      {s && !s.hardware_online && !status?.demo_mode && (
        <WarningBanner message="Controller is offline. Real actuator controls are disabled until a verified heartbeat is received." />
      )}

      {/* Control card */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Droplets className="h-4 w-4 text-solar-600" /> Cleaning system
              </CardTitle>
              <CardDescription>
                {s ? `${s.actuator.toUpperCase()} actuator · ${s.simulated ? "simulated" : "hardware"}` : "loading…"}
              </CardDescription>
            </div>
            {s && (
              <Badge
                variant={s.actuator_state === "running" ? "info" : s.actuator_state === "fault" ? "destructive" : "secondary"}
                size="lg"
              >
                {s.actuator_state}
              </Badge>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {!s ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                      <ShieldAlert className={cn("h-3.5 w-3.5", s.interlock_ok ? "text-emerald-600" : "text-red-600")} />
                      Safety interlock
                    </p>
                    <p className={cn("mt-1 text-sm font-semibold", s.interlock_ok ? "text-emerald-700" : "text-red-700")}>
                      {s.interlock_ok ? "Closed (safe)" : "Open / fault"}
                    </p>
                    {!s.interlock_ok && s.interlock_reason && (
                      <p className="mt-0.5 text-[11px] text-red-600">{s.interlock_reason}</p>
                    )}
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                      <Droplet className="h-3.5 w-3.5 text-sky-600" />
                      Water level
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-800">
                      {s.water_sensor_present && s.water_level_pct != null ? `${formatNumber(s.water_level_pct, 0)}%` : "not measured"}
                    </p>
                    {s.water_sensor_present && s.water_level_pct != null && (
                      <Progress value={s.water_level_pct} className="mt-1.5 h-1.5" />
                    )}
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                      <Timer className="h-3.5 w-3.5 text-amber-600" /> Cooldown
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-800">
                      {s.cooldown_remaining_s > 0 ? `${Math.ceil(s.cooldown_remaining_s / 60)} min left` : "clear"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                      <Gauge className="h-3.5 w-3.5 text-violet-600" /> Max runtime
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-800">{formatNumber(s.max_runtime_s / 60, 0)} min</p>
                  </div>
                </div>

                {s.fault && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                    <AlertOctagon className="mr-1 inline h-3.5 w-3.5" /> {s.fault}
                  </div>
                )}

                {currentJob && jobRunning && (
                  <div className="rounded-lg border border-sky-200 bg-sky-50 p-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 font-semibold text-sky-900">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cycle {currentJob.status}
                      </span>
                      <span className="font-mono text-sky-800">
                        {formatNumber(jobRuntime, 0)} / {formatNumber(s.max_runtime_s, 0)} s
                      </span>
                    </div>
                    <Progress
                      value={Math.min(100, (jobRuntime / s.max_runtime_s) * 100)}
                      className="mt-2 h-1.5"
                      indicatorClassName="bg-sky-600"
                    />
                    <p className="mt-1.5 text-[11px] text-sky-800">
                      Triggered by {currentJob.trigger} · {currentJob.reason}
                    </p>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => setConfirmStart(true)}
                    disabled={startDisabled}
                    title={startReason ?? "Start a cleaning cycle"}
                    className="flex-1"
                  >
                    {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    Start cleaning
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => setConfirmStop(true)}
                    disabled={!canControl || !jobRunning}
                    className="flex-1"
                  >
                    {busy === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                    Stop
                  </Button>
                </div>

                {startReason && (
                  <p className="flex items-start gap-1.5 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                    <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                    {startReason}
                  </p>
                )}

                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
                  <div>
                    <Label htmlFor="auto-clean" className="text-xs">
                      Automatic cleaning
                    </Label>
                    <p className="text-[11px] text-slate-500">
                      Initiate cycles automatically when the policy is satisfied
                    </p>
                  </div>
                  <Switch
                    id="auto-clean"
                    checked={s.auto_cleaning_enabled}
                    disabled={!canControl || busy === "auto"}
                    onCheckedChange={(v) => void toggleAuto(v)}
                  />
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => void testActuator()}
                  disabled={!canControl || !s.hardware_online || busy === "test"}
                >
                  {busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Settings2 className="h-3.5 w-3.5" />}
                  Test actuator (2 s pulse)
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          <DecisionPanel />
        </div>
      </div>

      {/* Stats + policy */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4 text-solar-600" /> Cleaning statistics
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!s ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile icon={<CheckCircle2 className="h-4 w-4" />} label="Completed cycles" value={s.cycles_completed} sub={`${s.cycles_failed} failed`} tone="ok" />
                <StatTile
                  icon={<Timer className="h-4 w-4" />}
                  label="Last duration"
                  value={s.last_cycle_duration_s != null ? `${formatNumber(s.last_cycle_duration_s, 0)} s` : "—"}
                  sub={s.last_cycle_at ? relativeTime(s.last_cycle_at) : "never"}
                />
                <StatTile
                  icon={<Droplet className="h-4 w-4" />}
                  label="Water consumed"
                  value={s.water_consumed_l != null ? `${formatNumber(s.water_consumed_l, 1)} L` : "not measured"}
                  sub="total recorded"
                />
                <StatTile
                  icon={<Zap className="h-4 w-4" />}
                  label="Cleaning energy"
                  value={s.energy_consumed_wh != null ? `${formatNumber(s.energy_consumed_wh, 1)} Wh` : "not measured"}
                  sub="actuator consumption"
                />
                <StatTile
                  icon={<Power className="h-4 w-4" />}
                  label="Actuator state"
                  value={s.actuator_state}
                  sub={s.hardware_online ? "acknowledged by device" : "no acknowledgement path"}
                  tone={s.actuator_state === "fault" ? "bad" : s.actuator_state === "running" ? "warn" : "default"}
                />
                <StatTile
                  icon={<Lock className="h-4 w-4" />}
                  label="Interlock"
                  value={s.interlock_ok ? "safe" : "fault"}
                  sub={s.interlock_reason ?? "all checks passed"}
                  tone={s.interlock_ok ? "ok" : "bad"}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-solar-600" /> Control parameters
            </CardTitle>
            <CardDescription>Applies to the decision policy</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {settings.loading && !settings.data ? (
              <Skeleton className="h-40 w-full" />
            ) : settings.error ? (
              <ErrorState message={settings.error} onRetry={settings.reload} />
            ) : settings.data ? (
              <>
                <div>
                  <Label className="text-[11px]">Policy mode</Label>
                  <Select
                    ariaLabel="Cleaning policy"
                    value={(settingsDraft.policy as string) ?? settings.data.settings.policy}
                    onValueChange={(v) => setSettingsDraft((d) => ({ ...d, policy: v }))}
                    disabled={!hasRole("admin")}
                    options={[
                      { value: "monitoring_only", label: "Monitoring only (default)" },
                      { value: "recommendation_only", label: "Recommendation only" },
                      { value: "manual_approval", label: "Manual approval required" },
                      { value: "automatic", label: "Automatic cleaning enabled" },
                    ]}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-[11px]">Soiling threshold (% normalised loss)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={95}
                    disabled={!hasRole("admin")}
                    value={(settingsDraft.soiling_threshold_pct as string) ?? settings.data.settings.soiling_threshold_pct}
                    onChange={(e) => setSettingsDraft((d) => ({ ...d, soiling_threshold_pct: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-[11px]">Cooldown (seconds)</Label>
                  <Input
                    type="number"
                    min={60}
                    disabled={!hasRole("admin")}
                    value={(settingsDraft.cleaning_cooldown_s as string) ?? settings.data.settings.cleaning_cooldown_s}
                    onChange={(e) => setSettingsDraft((d) => ({ ...d, cleaning_cooldown_s: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-[11px]">Max runtime (seconds)</Label>
                  <Input
                    type="number"
                    min={10}
                    max={3600}
                    disabled={!hasRole("admin")}
                    value={(settingsDraft.max_cleaning_runtime_s as string) ?? settings.data.settings.max_cleaning_runtime_s}
                    onChange={(e) => setSettingsDraft((d) => ({ ...d, max_cleaning_runtime_s: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <Button
                  size="sm"
                  className="w-full"
                  disabled={!hasRole("admin") || savingSettings || Object.keys(settingsDraft).length === 0}
                  onClick={() => void saveInlineSettings()}
                >
                  {savingSettings && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Save parameters
                </Button>
                {!hasRole("admin") && (
                  <p className="text-[11px] text-slate-400">Admin role required to change control parameters.</p>
                )}
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-solar-600" /> Cleaning history
          </CardTitle>
          <CardDescription>
            Before/after power figures are compared only when both windows are valid; see the note in each row
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.loading && !history.data ? (
            <Skeleton className="h-40 w-full" />
          ) : !history.data || history.data.items.length === 0 ? (
            <EmptyState
              icon={<Droplets className="h-5 w-5" />}
              title="No cleaning cycles recorded"
              message="Start a cycle (operator role) or wait for an automatic cycle in demo mode."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-3">Requested</th>
                    <th className="py-2 pr-3">Trigger</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Duration</th>
                    <th className="py-2 pr-3">Water</th>
                    <th className="py-2 pr-3">Energy</th>
                    <th className="py-2 pr-3">Power before → after</th>
                    <th className="py-2 pr-3">Change</th>
                    <th className="py-2 pr-3">By</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.items.map((j: CleaningJob) => (
                    <tr key={j.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-2 pr-3 text-xs text-slate-600">{formatDateTime(j.requested_at)}</td>
                      <td className="py-2 pr-3">
                        <Badge variant="outline" size="sm">{j.trigger}</Badge>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge
                          variant={
                            j.status === "completed"
                              ? "success"
                              : j.status === "running" || j.status === "queued"
                                ? "info"
                                : j.status === "failed"
                                  ? "destructive"
                                  : "secondary"
                          }
                          size="sm"
                        >
                          {j.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-xs">{j.duration_s != null ? `${formatNumber(j.duration_s, 0)} s` : "—"}</td>
                      <td className="py-2 pr-3 text-xs">{j.water_liters != null ? `${formatNumber(j.water_liters, 1)} L` : "—"}</td>
                      <td className="py-2 pr-3 text-xs">{j.energy_wh != null ? `${formatNumber(j.energy_wh, 1)} Wh` : "—"}</td>
                      <td className="py-2 pr-3 text-xs">
                        {j.power_before_w != null && j.power_after_w != null
                          ? `${formatNumber(j.power_before_w, 0)} → ${formatNumber(j.power_after_w, 0)} W`
                          : "not measured"}
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {j.delta_pct != null ? (
                          <span className={j.delta_pct >= 0 ? "font-medium text-emerald-600" : "font-medium text-red-600"}>
                            {j.delta_pct >= 0 ? "+" : ""}
                            {formatNumber(j.delta_pct, 1)}%
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-3 text-[11px] text-slate-500">{j.initiated_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {history.data && history.data.simulated && (
            <p className="mt-3 text-[11px] text-slate-500">
              Rows marked by demo mode are simulated actuator cycles — no hardware was operated.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Confirmation dialogs */}
      <AlertDialog open={confirmStart} onOpenChange={setConfirmStart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" /> Start cleaning cycle?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will energise the {s?.actuator ?? "pump"} for up to {s ? formatNumber(s.max_runtime_s / 60, 0) : "—"} minutes
              {s?.simulated ? " (simulated actuator in demo mode)" : ""}. The command is authenticated, rate-limited and
              written to the audit log. Only start when the area is clear of personnel.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogButtons
            confirmLabel="Start cleaning"
            onConfirm={() => void startCleaning()}
            onCancel={() => setConfirmStart(false)}
            disabled={busy === "start"}
          />
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Power className="h-5 w-5 text-red-600" /> Stop cleaning cycle?
            </AlertDialogTitle>
            <AlertDialogDescription>
              A stop command will be sent. The cycle is only considered stopped once the device acknowledges the
              idle state — if no acknowledgement arrives within the timeout the fault will be reported.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogButtons
            confirmLabel="Stop now"
            destructive
            onConfirm={() => void stopCleaning()}
            onCancel={() => setConfirmStop(false)}
            disabled={busy === "stop"}
          />
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
