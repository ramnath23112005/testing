import * as React from "react";
import {
  AlertTriangle,
  BrainCircuit,
  Camera,
  CheckCircle2,
  Cpu,
  Eye,
  History,
  ImageUp,
  Info,
  Loader2,
  ScanSearch,
  Trash2,
  XCircle,
} from "lucide-react";
import { api, mediaUrl } from "@/lib/api";
import { useAsync, useDebounced } from "@/lib/hooks";
import { useAuth } from "@/context/AuthContext";
import { useSystem } from "@/context/SystemContext";
import { cn, formatDateTime, formatNumber, relativeTime } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogButtons,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ClassBadge,
  EmptyState,
  ErrorState,
  InfoBanner,
  PageHeader,
  SourceBadge,
  WarningBanner,
} from "@/components/shared/indicators";
import { BarsChart, SERIES } from "@/components/charts/chartkit";
import type { PredictResponse, Prediction } from "@/lib/types";

const MAX_MB = 8;
const ACCEPTED = ["image/jpeg", "image/jpg", "image/png"];

function validateFile(file: File): string | null {
  if (!ACCEPTED.includes(file.type)) return "Only JPG or PNG images are accepted.";
  if (file.size > MAX_MB * 1024 * 1024) return `File is larger than ${MAX_MB} MB.`;
  if (file.size < 1024) return "File is too small to be a valid image.";
  return null;
}

/* ------------------------------ drop zone ------------------------------ */
function ImageDropzone({
  file,
  onFile,
  disabled,
}: {
  file: File | null;
  onFile: (f: File) => void;
  disabled?: boolean;
}) {
  const [drag, setDrag] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (disabled) return;
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
        drag ? "border-solar-500 bg-solar-50" : "border-slate-300 bg-slate-50",
        disabled && "opacity-60",
      )}
    >
      <ImageUp className={cn("h-7 w-7", drag ? "text-solar-600" : "text-slate-400")} />
      <p className="mt-2 text-sm font-medium text-slate-700">
        {file ? file.name : "Drag & drop a panel image"}
      </p>
      <p className="mt-1 text-[11px] text-slate-500">
        JPG or PNG · max {MAX_MB} MB {file ? `· ${(file.size / 1024).toFixed(0)} KB` : ""}
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png"
        className="sr-only"
        aria-label="Choose panel image"
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        Choose file
      </Button>
    </div>
  );
}

/* ------------------------------ result card ---------------------------- */
function ResultCard({ data, onConfirm }: { data: PredictResponse; onConfirm: (cls: string) => void }) {
  const [showCam, setShowCam] = React.useState(false);
  const p = data.prediction;
  const probData = Object.entries(p.probabilities).map(([k, v]) => ({
    label: p.predicted_label && k === p.predicted_class ? `${k} ★` : k,
    value: Math.round(v * 100),
  }));

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <BrainCircuit className="h-4 w-4 text-solar-600" /> Classification result
          </CardTitle>
          <CardDescription>{formatDateTime(p.captured_at)}</CardDescription>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {p.demo ? (
            <Badge variant="info">DEMO RESULT</Badge>
          ) : p.source === "measured" ? (
            <SourceBadge source="measured" />
          ) : (
            <SourceBadge source="demo" />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {p.demo && data.message && <WarningBanner message={data.message} />}

        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Predicted class</p>
            <div className="mt-1 flex items-center gap-2">
              <ClassBadge value={p.predicted_class} label={p.predicted_label} />
            </div>
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Confidence</p>
            <p className="text-2xl font-semibold tabular-nums text-slate-900">
              {formatNumber(p.confidence * 100, 1)}
              <span className="text-sm text-slate-400">%</span>
            </p>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-500">
            <span>Per-class probability</span>
            <span>threshold applies to decisions, not raw output</span>
          </div>
          <BarsChart data={probData} dataKey="value" xKey="label" unit="%" color={SERIES.power} height={190} />
        </div>

        <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-[11px] text-slate-500">Model</dt>
            <dd className="mt-0.5 font-medium text-slate-800">{p.model_name}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-slate-500">Version</dt>
            <dd className="mt-0.5 font-mono text-[11px] text-slate-700">{p.model_version}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-slate-500">Inference time</dt>
            <dd className="mt-0.5 font-medium text-slate-800">{formatNumber(p.inference_ms, 1)} ms</dd>
          </div>
          <div>
            <dt className="text-[11px] text-slate-500">Image ID</dt>
            <dd className="mt-0.5 truncate font-mono text-[11px] text-slate-700">{p.image_id.slice(0, 10)}…</dd>
          </div>
        </dl>

        {p.quality_warnings.length > 0 && (
          <ul className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-900">
            {p.quality_warnings.map((w) => (
              <li key={w} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
              </li>
            ))}
          </ul>
        )}

        {p.recommendation && (
          <div className="rounded-lg border border-solar-200 bg-solar-50 px-3 py-2.5 text-xs text-solar-900">
            <span className="font-semibold">Recommendation: </span>
            {p.recommendation}
          </div>
        )}

        {p.gradcam_url && (
          <div>
            <Button variant="outline" size="sm" onClick={() => setShowCam((s) => !s)}>
              <Eye className="h-3.5 w-3.5" /> {showCam ? "Hide" : "Show"} attention map (Grad-CAM)
            </Button>
            {showCam && (
              <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
                <img src={mediaUrl(p.gradcam_url) ?? ""} alt="Grad-CAM attention map" className="w-full" />
                <p className="border-t border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                  The heatmap shows where the model looked. It is <strong>not proof</strong> of the physical
                  cause of soiling and does not measure dust thickness.
                </p>
              </div>
            )}
          </div>
        )}

        {data.decision && (
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Combined sensor-fusion decision
            </p>
            <p className="mt-1.5 text-sm font-semibold text-slate-800">{data.decision.action_label}</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">{data.decision.explanation}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <span className="text-[11px] text-slate-500">Expert confirmation (optional):</span>
          {["clean", "lightly_dusty", "heavily_dusty", "bird_dropping"].map((c) => (
            <Button
              key={c}
              size="sm"
              variant={p.confirmed_class === c ? "default" : "outline"}
              className="h-7 px-2 text-[11px]"
              onClick={() => onConfirm(c)}
            >
              {c.replace("_", " ")}
            </Button>
          ))}
        </div>
        {!data.model_available && !p.demo && (
          <p className="text-[11px] text-slate-500">{data.message}</p>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------ history -------------------------------- */
function HistoryList({
  onOpen,
  refreshKey,
}: {
  onOpen: (p: Prediction) => void;
  refreshKey: number;
}) {
  const { hasRole } = useAuth();
  const { toast } = useToast();
  const [cls, setCls] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [detail, setDetail] = React.useState<Prediction | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const searchFrom = useDebounced(from, 400);
  const searchTo = useDebounced(to, 400);

  const list = useAsync(
    () =>
      api.predictions({
        page,
        page_size: 8,
        predicted_class: cls === "all" ? undefined : cls,
        from: searchFrom ? new Date(searchFrom).toISOString() : undefined,
        to: searchTo ? new Date(searchTo).toISOString() : undefined,
      }),
    [cls, page, searchFrom, searchTo, refreshKey],
    { pollMs: 45_000 },
  );

  React.useEffect(() => {
    setPage(1);
  }, [cls, searchFrom, searchTo]);

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 8));

  async function confirm(p: Prediction, c: string) {
    try {
      await api.confirmPrediction(p.id, c);
      toast({ title: "Confirmation saved", description: `Ground truth label recorded: ${c.replace("_", " ")}`, variant: "success" });
      list.reload();
    } catch (e) {
      toast({ title: "Could not save confirmation", description: e instanceof Error ? e.message : "", variant: "error" });
    }
  }

  async function remove(imageId: string) {
    setDeleting(imageId);
    try {
      await api.deleteImage(imageId);
      toast({ title: "Image deleted", variant: "success" });
      setDetail(null);
      list.reload();
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-end justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-solar-600" /> Prediction history
          </CardTitle>
          <CardDescription>Stored images, classifications, model versions and expert confirmations</CardDescription>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <Label className="text-[10px]">Class filter</Label>
            <Select
              ariaLabel="Filter by class"
              value={cls}
              onValueChange={setCls}
              options={[
                { value: "all", label: "All classes" },
                { value: "clean", label: "Clean" },
                { value: "lightly_dusty", label: "Lightly dusty" },
                { value: "heavily_dusty", label: "Heavily dusty" },
                { value: "bird_dropping", label: "Bird dropping" },
              ]}
              className="mt-1 h-8 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-8 text-xs" />
          </div>
          <div>
            <Label className="text-[10px]">To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-8 text-xs" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {list.loading && !list.data ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : !list.data || list.data.items.length === 0 ? (
          <EmptyState
            icon={<ScanSearch className="h-5 w-5" />}
            title="No predictions yet"
            message="Analyse a panel image above to start building the prediction history."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-3">Image</th>
                    <th className="py-2 pr-3">Class</th>
                    <th className="py-2 pr-3">Confidence</th>
                    <th className="py-2 pr-3">Model</th>
                    <th className="py-2 pr-3">Captured</th>
                    <th className="py-2 pr-3">Source</th>
                    <th className="py-2 pr-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((p) => (
                    <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-2 pr-3">
                        <img
                          src={mediaUrl(p.image_url) ?? ""}
                          alt="panel thumbnail"
                          className="h-10 w-14 rounded border border-slate-200 object-cover"
                          loading="lazy"
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <ClassBadge value={p.predicted_class} label={p.predicted_label} />
                        {p.confirmed_class && (
                          <Badge variant="outline" size="sm" className="ml-1.5">
                            <CheckCircle2 className="h-3 w-3" /> {p.confirmed_class.replace("_", " ")}
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <Progress value={p.confidence * 100} className="h-1.5 w-16" />
                          <span className="font-mono text-xs text-slate-600">{formatNumber(p.confidence * 100, 0)}%</span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 font-mono text-[11px] text-slate-600">{p.model_version}</td>
                      <td className="py-2 pr-3 text-xs text-slate-600">{relativeTime(p.captured_at)}</td>
                      <td className="py-2 pr-3">
                        {p.demo ? <Badge variant="info" size="sm">DEMO</Badge> : <SourceBadge source={p.source} />}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <div className="inline-flex gap-1">
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => onOpen(p)}>
                            Load
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setDetail(p)}>
                            Details
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
              <span>
                {total} prediction{total === 1 ? "" : "s"} · page {page} of {pages}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={page >= pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}

        <AlertDialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
          <AlertDialogContent className="max-w-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Prediction detail</AlertDialogTitle>
              <AlertDialogDescription>
                {detail && `${detail.predicted_label} · ${formatDateTime(detail.captured_at)}`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {detail && (
              <div className="grid gap-4 sm:grid-cols-2">
                <img
                  src={mediaUrl(detail.image_url) ?? ""}
                  alt="Analysed panel"
                  className="w-full rounded-lg border border-slate-200 object-contain"
                />
                <div className="space-y-2 text-xs">
                  {detail.gradcam_url && (
                    <img
                      src={mediaUrl(detail.gradcam_url) ?? ""}
                      alt="Grad-CAM overlay"
                      className="w-full rounded-lg border border-slate-200"
                    />
                  )}
                  <dl className="space-y-1.5">
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Confidence</dt>
                      <dd className="font-medium text-slate-800">{formatNumber(detail.confidence * 100, 1)}%</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Model</dt>
                      <dd className="font-mono text-[11px]">{detail.model_name} {detail.model_version}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Inference</dt>
                      <dd>{formatNumber(detail.inference_ms, 1)} ms</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Source</dt>
                      <dd>{detail.demo ? "DEMO (not a trained model)" : detail.source}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Expert label</dt>
                      <dd>{detail.confirmed_class?.replace("_", " ") ?? "not confirmed"}</dd>
                    </div>
                  </dl>
                  <p className="rounded border border-slate-200 bg-slate-50 p-2 leading-relaxed text-slate-600">
                    {detail.recommendation || "No recommendation stored for this prediction."}
                  </p>
                  {hasRole("operator", "admin") && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {["clean", "lightly_dusty", "heavily_dusty", "bird_dropping"].map((c) => (
                        <Button
                          key={c}
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => {
                            void confirm(detail, c);
                          }}
                        >
                          {c.replace("_", " ")}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <AlertDialogButtons
              confirmLabel={hasRole("admin") ? "Delete image" : "Close"}
              destructive={hasRole("admin")}
              disabled={deleting !== null}
              onConfirm={() => {
                if (hasRole("admin") && detail) void remove(detail.image_id);
                setDetail(null);
              }}
              onCancel={() => setDetail(null)}
            />
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

/* ------------------------------- page ---------------------------------- */
export default function DetectionPage() {
  const { selectedDeviceId, selectedDevice } = useSystem();
  const { toast } = useToast();
  const [file, setFile] = React.useState<File | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<"real" | "demo" | "capture" | null>(null);
  const [result, setResult] = React.useState<PredictResponse | null>(null);
  const [historyKey, setHistoryKey] = React.useState(0);
  const previewRef = React.useRef<string | null>(null);

  const model = useAsync((signal) => api.modelInfo({ signal }), []);

  const preview = React.useMemo(() => {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
    if (!file) return null;
    const url = URL.createObjectURL(file);
    previewRef.current = url;
    return url;
  }, [file]);

  React.useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  function acceptFile(f: File) {
    const v = validateFile(f);
    if (v) {
      setError(v);
      setFile(null);
      return;
    }
    setError(null);
    setResult(null);
    setFile(f);
  }

  async function analyze(demo: boolean) {
    if (!file) return;
    setBusy(demo ? "demo" : "real");
    try {
      const res = demo ? await api.predictDemo(file, selectedDeviceId ?? undefined) : await api.predict(file, selectedDeviceId ?? undefined);
      setResult(res);
      setHistoryKey((k) => k + 1);
      toast({
        title: demo ? "Demo analysis complete" : "Analysis complete",
        description: `${res.prediction.predicted_label} · ${formatNumber(res.prediction.confidence * 100, 1)}%`,
        variant: "success",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Analysis failed";
      toast({ title: "Analysis failed", description: msg, variant: "error" });
      setError(msg);
    } finally {
      setBusy(null);
    }
  }

  async function capture() {
    if (!selectedDeviceId) return;
    setBusy("capture");
    try {
      const res = await api.captureImage(selectedDeviceId);
      const blobRes = await fetch(mediaUrl(res.image_url) ?? res.image_url);
      const blob = await blobRes.blob();
      const f = new File([blob], `capture-${Date.now()}.jpg`, { type: blob.type || "image/jpeg" });
      acceptFile(f);
      toast({ title: "Image captured", description: formatDateTime(res.captured_at), variant: "success" });
    } catch (e) {
      toast({
        title: "Capture failed",
        description: e instanceof Error ? e.message : "",
        variant: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  async function loadFromHistory(p: Prediction) {
    try {
      const res = await fetch(mediaUrl(p.image_url) ?? p.image_url);
      const blob = await res.blob();
      const f = new File([blob], `history-${p.image_id}.jpg`, { type: blob.type || "image/jpeg" });
      acceptFile(f);
      setResult({
        prediction: p,
        decision: null,
        model_available: model.data?.available ?? false,
        message: "Loaded from prediction history.",
      });
    } catch {
      toast({ title: "Could not load image", variant: "error" });
    }
  }

  async function confirmClass(cls: string) {
    if (!result) return;
    try {
      const updated = await api.confirmPrediction(result.prediction.id, cls);
      setResult({ ...result, prediction: updated });
      setHistoryKey((k) => k + 1);
      toast({ title: "Confirmation saved", variant: "success" });
    } catch (e) {
      toast({ title: "Could not confirm", description: e instanceof Error ? e.message : "", variant: "error" });
    }
  }

  const modelAvailable = model.data?.available ?? false;
  const cameraOk = selectedDevice?.camera_status === "ok" && (selectedDevice?.status === "online" || selectedDevice?.simulated);

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI Soiling Detection"
        description="Upload or capture a panel image, run inference and review per-class probabilities with explainability."
        tooltip={
          <>
            Images are validated server-side (type, size, magic bytes) and re-encoded before storage. A
            prediction is only issued by the configured model — or, without one, by a clearly marked demo rule.
          </>
        }
      />

      {model.loading ? (
        <Skeleton className="h-16 w-full" />
      ) : !modelAvailable ? (
        <WarningBanner message="MODEL NOT CONFIGURED — no trained weights are loaded, so real inference is disabled. You can still run a clearly labelled DEMO analysis (deterministic image statistics, not a neural network) to explore the workflow." />
      ) : (
        <InfoBanner
          message={`Model ready: ${model.data?.name} v${model.data?.version} · classes: ${(model.data?.classes ?? []).join(", ")}${
            model.data?.trained_for_four_class ? "" : " (four-class prediction not confirmed by training metadata)"
          }`}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Input side */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ImageUp className="h-4 w-4 text-solar-600" /> Image input
            </CardTitle>
            <CardDescription>
              JPG / JPEG / PNG up to {MAX_MB} MB{selectedDevice ? ` · device ${selectedDevice.display_name}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ImageDropzone file={file} onFile={acceptFile} disabled={busy !== null} />

            {error && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}

            {preview ? (
              <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                <img src={preview} alt="Selected panel preview" className="max-h-72 w-full object-contain" />
                <Button
                  size="sm"
                  variant="ghost"
                  className="absolute right-2 top-2 h-7 bg-white/90 px-2 text-[11px] shadow"
                  onClick={() => {
                    setFile(null);
                    setResult(null);
                    setError(null);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </Button>
              </div>
            ) : (
              <p className="text-center text-xs text-slate-400">No image selected.</p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button className="flex-1" disabled={!file || busy !== null || !modelAvailable} onClick={() => void analyze(false)}>
                {busy === "real" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
                Analyze panel
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                disabled={!file || busy !== null}
                onClick={() => void analyze(true)}
                title="Runs the deterministic demo rule (not a trained model)"
              >
                {busy === "demo" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cpu className="h-4 w-4" />}
                Run demo analysis
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
              <Button
                variant="outline"
                size="sm"
                disabled={!cameraOk || busy !== null}
                onClick={() => void capture()}
                title={cameraOk ? "Capture from the connected camera" : "Camera unavailable on this device"}
              >
                {busy === "capture" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
                Capture from camera
              </Button>
              {!cameraOk && (
                <span className="text-[11px] text-slate-400">
                  Camera {selectedDevice ? `status: ${selectedDevice.camera_status}` : "not available"} — upload an image instead.
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Result side */}
        {result ? (
          <ResultCard data={result} onConfirm={(c) => void confirmClass(c)} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BrainCircuit className="h-4 w-4 text-slate-400" /> Classification result
              </CardTitle>
              <CardDescription>Results appear here after analysis</CardDescription>
            </CardHeader>
            <CardContent>
              <EmptyState
                icon={<Cpu className="h-5 w-5" />}
                title="Awaiting analysis"
                message="Select an image and press “Analyze panel”. The result shows predicted class, confidence, per-class probabilities, model version and inference time."
              />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Model / limitations */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-4 w-4 text-solar-600" /> Model status and limitations
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="status">
            <TabsList>
              <TabsTrigger value="status">Model status</TabsTrigger>
              <TabsTrigger value="limits">Limitations of visual classification</TabsTrigger>
            </TabsList>
            <TabsContent value="status" className="mt-3">
              {model.loading ? (
                <Skeleton className="h-20 w-full" />
              ) : model.error ? (
                <ErrorState message={model.error} onRetry={model.reload} />
              ) : (
                <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-[11px] text-slate-500">Loaded model</p>
                    <p className="mt-1 font-medium text-slate-800">{model.data?.name ?? "—"}</p>
                    <p className="font-mono text-[11px] text-slate-500">{model.data?.version ?? ""}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-[11px] text-slate-500">Framework</p>
                    <p className="mt-1 font-medium text-slate-800">{model.data?.framework ?? "—"}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-[11px] text-slate-500">Input size</p>
                    <p className="mt-1 font-medium text-slate-800">
                      {model.data ? `${model.data.input_size[0]}×${model.data.input_size[1]}` : "—"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-[11px] text-slate-500">Four-class training confirmed</p>
                    <p className="mt-1">
                      {model.data?.trained_for_four_class ? (
                        <Badge variant="success" size="sm">yes</Badge>
                      ) : (
                        <Badge variant="warning" size="sm">not verified</Badge>
                      )}
                    </p>
                  </div>
                  <div className="sm:col-span-2 lg:col-span-4">
                    <p className="text-[11px] text-slate-500">Classes</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {(model.data?.classes ?? []).map((c) => (
                        <ClassBadge key={c} value={c} />
                      ))}
                    </div>
                    {model.data?.notes && <p className="mt-2 text-[11px] text-slate-500">{model.data.notes}</p>}
                  </div>
                </div>
              )}
            </TabsContent>
            <TabsContent value="limits" className="mt-3">
              <ul className="space-y-2 text-xs leading-relaxed text-slate-600">
                <li className="flex gap-2">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                  Camera images vary with time of day, angle and exposure; the same soiling level can produce
                  different appearances.
                </li>
                <li className="flex gap-2">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                  Glare, shadows and reflections can hide or imitate soiling; quality warnings are shown with
                  each result.
                </li>
                <li className="flex gap-2">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                  Classification confidence is not calibration: a 90 % score does not imply 90 % accuracy on
                  your site.
                </li>
                <li className="flex gap-2">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                  Attention heatmaps indicate where a model looked, never the physical cause of a prediction.
                </li>
                <li className="flex gap-2">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  Combine visual results with normalised electrical evidence (sensor fusion) before authorising
                  any cleaning.
                </li>
              </ul>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <HistoryList onOpen={(p) => void loadFromHistory(p)} refreshKey={historyKey} />
    </div>
  );
}
