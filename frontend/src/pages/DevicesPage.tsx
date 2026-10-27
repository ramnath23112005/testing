import * as React from "react";
import {
  Activity,
  Cpu,
  Edit3,
  History,
  Loader2,
  MapPin,
  Plus,
  Power,
  RefreshCw,
  Rss,
  ShieldCheck,
  Wifi,
  WifiOff,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogButtons,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState, ErrorState, PageHeader, WarningBanner } from "@/components/shared/indicators";
import type { Device } from "@/lib/types";

const componentTone = (s: string) =>
  s === "ok" ? "success" : s === "degraded" ? "warning" : s === "offline" ? "destructive" : "secondary";

interface FormState {
  id: string;
  display_name: string;
  location: string;
  panel_rating_w: string;
  telemetry_topic: string;
  command_topic: string;
  actuator_type: string;
  has_irradiance_sensor: boolean;
  has_climate_sensor: boolean;
}

const EMPTY_FORM: FormState = {
  id: "",
  display_name: "",
  location: "",
  panel_rating_w: "400",
  telemetry_topic: "",
  command_topic: "",
  actuator_type: "pump",
  has_irradiance_sensor: false,
  has_climate_sensor: false,
};

export default function DevicesPage() {
  const { hasRole } = useAuth();
  const { refreshDevices, refreshStatus, selectDevice, selectedDeviceId } = useSystem();
  const { toast } = useToast();
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Device | null>(null);
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<Device | null>(null);
  const [deactivating, setDeactivating] = React.useState<Device | null>(null);

  const devices = useAsync((signal) => api.devices({ signal }), [], { pollMs: 30_000 });
  const history = useAsync(
    () => (detail ? api.deviceHistory(detail.id) : Promise.resolve([])),
    [detail?.id],
    { pollMs: detail ? 15_000 : null },
  );

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(d: Device) {
    setEditing(d);
    setForm({
      id: d.id,
      display_name: d.display_name,
      location: d.location,
      panel_rating_w: String(d.panel_rating_w),
      telemetry_topic: d.telemetry_topic,
      command_topic: d.command_topic,
      actuator_type: d.actuator_type,
      has_irradiance_sensor: d.has_irradiance_sensor,
      has_climate_sensor: d.has_climate_sensor,
    });
    setFormError(null);
    setFormOpen(true);
  }

  async function save() {
    setFormError(null);
    if (form.display_name.trim().length < 2) {
      setFormError("Display name must be at least 2 characters.");
      return;
    }
    if (!editing && !/^[a-zA-Z0-9_-]{3,64}$/.test(form.id)) {
      setFormError("Device ID must be 3-64 characters: letters, numbers, '-' or '_'.");
      return;
    }
    const rating = Number(form.panel_rating_w);
    if (!Number.isFinite(rating) || rating <= 0 || rating > 10000) {
      setFormError("PV module rating must be between 1 and 10000 W.");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.updateDevice(editing.id, {
          display_name: form.display_name.trim(),
          location: form.location.trim(),
          panel_rating_w: rating,
          telemetry_topic: form.telemetry_topic,
          command_topic: form.command_topic,
          actuator_type: form.actuator_type as Device["actuator_type"],
          has_irradiance_sensor: form.has_irradiance_sensor,
          has_climate_sensor: form.has_climate_sensor,
        });
        toast({ title: "Device updated", variant: "success" });
      } else {
        await api.createDevice({
          id: form.id,
          display_name: form.display_name.trim(),
          location: form.location.trim(),
          panel_rating_w: rating,
          telemetry_topic: form.telemetry_topic,
          command_topic: form.command_topic,
          actuator_type: form.actuator_type as Device["actuator_type"],
          has_irradiance_sensor: form.has_irradiance_sensor,
          has_climate_sensor: form.has_climate_sensor,
        });
        toast({ title: "Device registered", description: form.id, variant: "success" });
      }
      setFormOpen(false);
      devices.reload();
      refreshDevices();
      refreshStatus();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function test(d: Device) {
    setTesting(d.id);
    try {
      const res = await api.testDevice(d.id);
      toast({ title: res.ok ? "Connection OK" : "Connection failed", description: res.detail, variant: res.ok ? "success" : "error" });
      devices.reload();
    } catch (e) {
      toast({ title: "Test failed", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setTesting(null);
    }
  }

  async function deactivate() {
    if (!deactivating) return;
    try {
      await api.updateDevice(deactivating.id, { active: false, status: "inactive" });
      toast({ title: "Device marked inactive", variant: "warning" });
      devices.reload();
      refreshDevices();
    } catch (e) {
      toast({ title: "Update failed", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setDeactivating(null);
    }
  }

  const list = devices.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Device Management"
        description="Register and supervise PV monitoring devices: camera, electrical sensor and cleaning controller."
        tooltip={
          <>
            A device is only reported as connected after its heartbeat or connection test is verified by the
            backend. Device secrets never reach the browser.
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => devices.reload()}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            {hasRole("admin") && (
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" /> Add device
              </Button>
            )}
          </>
        }
      />

      {devices.error && !list.length && <ErrorState message={devices.error} onRetry={devices.reload} />}
      {devices.loading && !list.length && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      )}

      {!devices.loading && list.length === 0 && !devices.error && (
        <EmptyState
          icon={<Cpu className="h-5 w-5" />}
          title="No devices registered"
          message="Register your first monitoring device to start collecting telemetry. Demo mode seeds a simulated device on first backend start."
          action={
            hasRole("admin") ? (
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" /> Add device
              </Button>
            ) : undefined
          }
        />
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list.map((d) => (
          <Card
            key={d.id}
            className={cn("relative", selectedDeviceId === d.id && "border-solar-500 ring-1 ring-solar-500/40")}
          >
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 truncate">
                  <Wifi className={cn("h-4 w-4", d.status === "online" ? "text-emerald-600" : "text-slate-400")} />
                  {d.display_name}
                </CardTitle>
                <CardDescription className="flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> {d.location || "no location"} · <span className="font-mono">{d.id}</span>
                </CardDescription>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Badge variant={d.status === "online" ? "success" : d.status === "inactive" ? "secondary" : "destructive"} size="sm">
                  {d.status}
                </Badge>
                {d.simulated && <Badge variant="info" size="sm">simulated</Badge>}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg border border-slate-200 bg-slate-50 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Camera</p>
                  <Badge variant={componentTone(d.camera_status)} size="sm" className="mt-1">
                    {d.camera_status}
                  </Badge>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Sensor</p>
                  <Badge variant={componentTone(d.electrical_sensor_status)} size="sm" className="mt-1">
                    {d.electrical_sensor_status}
                  </Badge>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Controller</p>
                  <Badge variant={componentTone(d.controller_status)} size="sm" className="mt-1">
                    {d.controller_status}
                  </Badge>
                </div>
              </div>

              <dl className="space-y-1.5 text-[11px]">
                <div className="flex justify-between">
                  <dt className="text-slate-500">PV rating</dt>
                  <dd className="font-medium text-slate-700">{formatNumber(d.panel_rating_w, 0)} W</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Heartbeat</dt>
                  <dd className="font-medium text-slate-700">{d.last_heartbeat ? relativeTime(d.last_heartbeat) : "never"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Firmware</dt>
                  <dd className="font-mono text-slate-700">{d.firmware_version ?? "not reported"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Mode</dt>
                  <dd className="font-medium text-slate-700">{d.operating_mode}</dd>
                </div>
              </dl>

              <Separator />

              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="flex-1" onClick={() => setDetail(d)}>
                  <History className="h-3.5 w-3.5" /> Details
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  onClick={() => void test(d)}
                  disabled={testing !== null}
                >
                  {testing === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rss className="h-3.5 w-3.5" />}
                  Test
                </Button>
                <Button size="sm" variant="ghost" onClick={() => selectDevice(d.id)} title="Set as active device">
                  <Power className="h-3.5 w-3.5" /> Use
                </Button>
                {hasRole("admin") && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(d)} aria-label={`Edit ${d.display_name}`}>
                      <Edit3 className="h-3.5 w-3.5" />
                    </Button>
                    {d.active && (
                      <Button size="sm" variant="ghost" onClick={() => setDeactivating(d)} aria-label="Mark inactive">
                        <WifiOff className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Device detail */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-solar-600" /> {detail?.display_name}
            </DialogTitle>
            <DialogDescription>
              {detail ? `${detail.id} · ${detail.location || "no location"}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
                <div className="rounded-lg border border-slate-200 p-2.5">
                  <p className="text-[10px] uppercase text-slate-500">PV module rating</p>
                  <p className="mt-0.5 font-semibold text-slate-800">{formatNumber(detail.panel_rating_w, 0)} W</p>
                </div>
                <div className="rounded-lg border border-slate-200 p-2.5">
                  <p className="text-[10px] uppercase text-slate-500">Actuator</p>
                  <p className="mt-0.5 font-semibold text-slate-800">{detail.actuator_type}</p>
                </div>
                <div className="rounded-lg border border-slate-200 p-2.5">
                  <p className="text-[10px] uppercase text-slate-500">Sensors</p>
                  <p className="mt-0.5 font-semibold text-slate-800">
                    {detail.has_irradiance_sensor ? "irradiance" : "no irradiance"} ·{" "}
                    {detail.has_climate_sensor ? "climate" : "no climate"}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 p-2.5">
                  <p className="text-[10px] uppercase text-slate-500">Telemetry topic</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-slate-700">{detail.telemetry_topic || "—"}</p>
                </div>
                <div className="rounded-lg border border-slate-200 p-2.5">
                  <p className="text-[10px] uppercase text-slate-500">Command topic</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-slate-700">{detail.command_topic || "—"}</p>
                </div>
                <div className="rounded-lg border border-slate-200 p-2.5">
                  <p className="text-[10px] uppercase text-slate-500">Modules</p>
                  <p className="mt-0.5 font-semibold text-slate-800">{detail.modules.length}</p>
                </div>
              </div>

              <div>
                <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <History className="h-3.5 w-3.5" /> Connection history
                </p>
                {history.loading ? (
                  <Skeleton className="h-24 w-full" />
                ) : history.error ? (
                  <p className="text-xs text-red-600">{history.error}</p>
                ) : (history.data ?? []).length === 0 ? (
                  <p className="text-xs text-slate-400">No connection events recorded.</p>
                ) : (
                  <ul className="max-h-52 space-y-1.5 overflow-y-auto rounded-lg border border-slate-200 p-2.5">
                    {(history.data ?? []).slice(0, 30).map((h, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="flex items-center gap-2">
                          <Badge variant={h.status === "online" ? "success" : "secondary"} size="sm">
                            {h.status}
                          </Badge>
                          <span className="text-slate-600">{h.detail}</span>
                        </span>
                        <span className="whitespace-nowrap text-slate-400">{formatDateTime(h.ts)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add / edit form */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit device" : "Register device"}</DialogTitle>
            <DialogDescription>
              {editing ? `Update metadata for ${editing.id}` : "Add a new PV monitoring device"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {formError && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {formError}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className={editing ? "col-span-2 opacity-60" : "col-span-2"}>
                <Label htmlFor="dev-id" className="text-[11px]">
                  Device ID
                </Label>
                <Input
                  id="dev-id"
                  value={form.id}
                  disabled={!!editing}
                  placeholder="e.g. esp32cam-roof-01"
                  onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div className="col-span-2">
                <Label htmlFor="dev-name" className="text-[11px]">
                  Display name
                </Label>
                <Input
                  id="dev-name"
                  value={form.display_name}
                  placeholder="Roof array – row A"
                  onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div className="col-span-2">
                <Label htmlFor="dev-loc" className="text-[11px]">
                  Location
                </Label>
                <Input
                  id="dev-loc"
                  value={form.location}
                  placeholder="Building roof, west wing"
                  onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="dev-rating" className="text-[11px]">
                  PV rating (W)
                </Label>
                <Input
                  id="dev-rating"
                  type="number"
                  value={form.panel_rating_w}
                  onChange={(e) => setForm((f) => ({ ...f, panel_rating_w: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-[11px]">Actuator type</Label>
                <Select
                  ariaLabel="Actuator type"
                  value={form.actuator_type}
                  onValueChange={(v) => setForm((f) => ({ ...f, actuator_type: v }))}
                  options={[
                    { value: "pump", label: "Water pump / sprinkler" },
                    { value: "motor", label: "Motorised brush" },
                    { value: "wiper", label: "Wiper mechanism" },
                    { value: "none", label: "None" },
                  ]}
                  className="mt-1"
                />
              </div>
              <div className="col-span-2">
                <Label htmlFor="dev-tt" className="text-[11px]">
                  Telemetry topic (MQTT)
                </Label>
                <Input
                  id="dev-tt"
                  value={form.telemetry_topic}
                  placeholder="soilingguard/telemetry/<device_id>"
                  onChange={(e) => setForm((f) => ({ ...f, telemetry_topic: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div className="col-span-2">
                <Label htmlFor="dev-ct" className="text-[11px]">
                  Command topic (MQTT)
                </Label>
                <Input
                  id="dev-ct"
                  value={form.command_topic}
                  placeholder="soilingguard/command/<device_id>"
                  onChange={(e) => setForm((f) => ({ ...f, command_topic: e.target.value }))}
                  className="mt-1"
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
              <div>
                <Label className="text-xs">Irradiance sensor</Label>
                <p className="text-[11px] text-slate-500">Enables irradiance-normalised power evaluation</p>
              </div>
              <Switch
                checked={form.has_irradiance_sensor}
                onCheckedChange={(v) => setForm((f) => ({ ...f, has_irradiance_sensor: v }))}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5">
              <div>
                <Label className="text-xs">Climate sensor</Label>
                <p className="text-[11px] text-slate-500">Panel/ambient temperature and humidity</p>
              </div>
              <Switch
                checked={form.has_climate_sensor}
                onCheckedChange={(v) => setForm((f) => ({ ...f, has_climate_sensor: v }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? "Save changes" : "Register device"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deactivating} onOpenChange={(o) => !o && setDeactivating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark device inactive?</AlertDialogTitle>
            <AlertDialogDescription>
              {deactivating?.display_name} will stop being polled and its actuator controls will be disabled.
              Historical data is retained.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogButtons
            confirmLabel="Mark inactive"
            destructive
            onConfirm={() => void deactivate()}
            onCancel={() => setDeactivating(null)}
          />
        </AlertDialogContent>
      </AlertDialog>

      {!hasRole("admin") && list.length > 0 && (
        <WarningBanner message="You are signed in with a read-only role: device registration, editing and deactivation require the admin role." />
      )}
      <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
        <Activity className="h-3.5 w-3.5" /> Connection state reflects verified heartbeats only — a device is never
        reported as connected without backend confirmation.
      </p>
    </div>
  );
}
