import * as React from "react";
import { Download, FileBarChart, Loader2, Printer, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useSystem } from "@/context/SystemContext";
import { formatDateTime, formatNumber } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  EmptyState,
  ErrorState,
  InfoBanner,
  KpiValue,
  PageHeader,

  WarningBanner,
} from "@/components/shared/indicators";
import { BarsChart, DonutChart, LegendDot, MultiLineChart, PIE_COLORS, SERIES, StackedBars } from "@/components/charts/chartkit";

function Kpi({ label, value, unit, sub }: { label: string; value: React.ReactNode; unit?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <div className="mt-1.5">
        <KpiValue value={value} unit={unit} />
      </div>
      {sub && <p className="mt-1 text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

export default function AnalyticsPage() {
  const { status } = useSystem();
  const { toast } = useToast();
  const [from, setFrom] = React.useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [exporting, setExporting] = React.useState(false);

  const summary = useAsync(
    (signal) =>
      api.analyticsSummary({
        from: new Date(from).toISOString(),
        to: new Date(`${to}T23:59:59`).toISOString(),
      }).then((r) => {
        void signal;
        return r;
      }),
    [from, to],
    { pollMs: 60_000 },
  );

  const data = summary.data;

  const classDistribution = data
    ? Object.entries(data.classification_counts)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => ({ name: k.replace("_", " "), value: v }))
    : [];

  const confBuckets = data?.confidence_histogram ?? [];

  const powerBeforeAfter = (data?.power_before_after ?? []).map((r) => ({
    label: formatDateTime(r.when).slice(0, 16),
    before: Math.round(r.before_w),
    after: Math.round(r.after_w),
    delta: Number(r.delta_pct.toFixed(1)),
  }));

  const energySeries = (data?.energy_series ?? []).map((r) => ({ label: r.date, energy: Math.round(r.wh) }));

  const perfSeries = (data?.perf_series ?? []).map((r) => ({
    ts: r.ts,
    actual_w: Math.round(r.actual_w),
    reference_w: Math.round(r.reference_w),
    ratio: Number((r.ratio * 100).toFixed(1)),
  }));

  async function exportCsv() {
    setExporting(true);
    try {
      await api.csvDownload("/api/export/analytics", `analytics-${from}_${to}.csv`, {
        from: new Date(from).toISOString(),
        to: new Date(`${to}T23:59:59`).toISOString(),
      });
      toast({ title: "Export ready", variant: "success" });
    } catch (e) {
      toast({ title: "Export failed", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5 print-area">
      <PageHeader
        title="Performance Analytics"
        description="Soiling detections, electrical trends, cleaning outcomes and model evaluation — filtered by date range."
        tooltip={
          <>
            Classification accuracy, precision, recall and F1 are only shown when independently verified
            ground-truth labels exist. They are never derived from model confidence.
          </>
        }
        actions={
          <div className="no-print flex flex-wrap items-end gap-2">
            <div>
              <Label className="text-[10px]">From</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-8 text-xs" />
            </div>
            <div>
              <Label className="text-[10px]">To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-8 text-xs" />
            </div>
            <Button size="sm" variant="outline" onClick={() => void summary.reload()}>
              <RefreshCw className="h-3.5 w-3.5" /> Apply
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void exportCsv()} disabled={exporting}>
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Export CSV
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.print()}>
              <Printer className="h-3.5 w-3.5" /> Print report
            </Button>
          </div>
        }
      />

      {status?.demo_mode && (
        <InfoBanner message="DEMO MODE: analytics below are computed from simulated telemetry and demo predictions." />
      )}

      {summary.error && !data && <ErrorState message={summary.error} onRetry={summary.reload} />}

      {summary.loading && !data ? (
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Kpi
              label="Predictions"
              value={Object.values(data.classification_counts).reduce((a, b) => a + b, 0)}
              sub="in selected range"
            />
            <Kpi label="Cleaning recommendations" value={data.cleaning_recommendations} sub="decisions issued" />
            <Kpi
              label="Confirmed cleaning events"
              value={data.confirmed_cleaning_events}
              sub="completed cycles"
            />
            <Kpi
              label="Avg power recovery"
              value={data.power_recovery.avg_delta_pct != null ? `${data.power_recovery.avg_delta_pct >= 0 ? "+" : ""}${formatNumber(data.power_recovery.avg_delta_pct, 1)}` : "—"}
              unit="%"
              sub={data.power_recovery.measured ? "measured" : "estimate"}
            />
            <Kpi
              label="Cleaning cycles"
              value={data.cleaning_stats.cycles}
              sub={`${data.cleaning_stats.failed} failed · ${data.cleaning_stats.aborted} aborted`}
            />
            <Kpi
              label="Cleaning success rate"
              value={data.cleaning_stats.success_rate_pct != null ? `${formatNumber(data.cleaning_stats.success_rate_pct, 0)}%` : "—"}
              sub={data.cleaning_stats.success_criterion}
            />
          </div>

          {!data.power_recovery.measured && (
            <WarningBanner
              message={`Energy recovery figures are estimates: ${data.power_recovery.note}`}
            />
          )}

          <Tabs defaultValue="soiling">
            <TabsList className="no-print">
              <TabsTrigger value="soiling">Soiling analytics</TabsTrigger>
              <TabsTrigger value="electrical">Electrical analytics</TabsTrigger>
              <TabsTrigger value="cleaning">Cleaning analytics</TabsTrigger>
              <TabsTrigger value="model">Model performance</TabsTrigger>
            </TabsList>

            {/* ------------------------- soiling ------------------------- */}
            <TabsContent value="soiling" className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <FileBarChart className="h-4 w-4 text-solar-600" /> Classification distribution
                    </CardTitle>
                    <CardDescription>Stored predictions grouped by predicted class</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {classDistribution.length === 0 ? (
                      <EmptyState title="No predictions in range" message="Run analyses or widen the date filter." />
                    ) : (
                      <DonutChart data={classDistribution} />
                    )}
                    <div className="mt-2 flex justify-center gap-3">
                      {classDistribution.map((c, i) => (
                        <LegendDot key={c.name} color={PIE_COLORS[i % PIE_COLORS.length]} label={`${c.name}: ${c.value}`} />
                      ))}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Confidence distribution</CardTitle>
                    <CardDescription>How confident the model was across stored predictions</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {confBuckets.length === 0 ? (
                      <EmptyState title="No confidence data" message="Predictions will populate this chart." />
                    ) : (
                      <BarsChart data={confBuckets.map((b) => ({ ...b, label: b.bucket }))} dataKey="count" xKey="label" color={SERIES.voltage} />
                    )}
                  </CardContent>
                </Card>

                <Card className="lg:col-span-2">
                  <CardHeader>
                    <CardTitle>Soiling detections over time</CardTitle>
                    <CardDescription>Daily count of stored predictions with their average confidence</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {data.detections_over_time.length === 0 ? (
                      <EmptyState title="No detections in range" message="Widen the date filter to see history." />
                    ) : (
                      <StackedBars
                        data={data.detections_over_time.map((d) => ({ label: d.date, detections: d.count, avg_conf: Math.round(d.avg_confidence * 100) }))}
                        keys={[
                          { key: "detections", color: SERIES.power, name: "detections" },
                          { key: "avg_conf", color: SERIES.irradiance, name: "avg confidence (%)" },
                        ]}
                      />
                    )}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            {/* ----------------------- electrical ------------------------ */}
            <TabsContent value="electrical" className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Power before and after cleaning</CardTitle>
                    <CardDescription>Raw measured values around each completed cycle</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {powerBeforeAfter.length === 0 ? (
                      <EmptyState title="No completed cycles" message="Cleaning outcomes will appear here." />
                    ) : (
                      <StackedBars
                        data={powerBeforeAfter}
                        keys={[
                          { key: "before", color: SERIES.before, name: "before (W)" },
                          { key: "after", color: SERIES.after, name: "after (W)" },
                        ]}
                      />
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Energy production over time</CardTitle>
                    <CardDescription>Daily energy integrated from sampled power (Wh)</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {energySeries.length === 0 ? (
                      <EmptyState title="No energy data" message="Telemetry history will populate this chart." />
                    ) : (
                      <BarsChart data={energySeries} dataKey="energy" xKey="label" color={SERIES.irradiance} unit=" Wh" />
                    )}
                  </CardContent>
                </Card>

                <Card className="lg:col-span-2">
                  <CardHeader>
                    <CardTitle>Reference-normalised performance</CardTitle>
                    <CardDescription>
                      Measured power against the configured reference under comparable conditions
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {perfSeries.length === 0 ? (
                      <EmptyState
                        title="No normalised series"
                        message="Requires an irradiance/reference method to be configured and sufficient telemetry."
                      />
                    ) : (
                      <>
                        <MultiLineChart
                          data={perfSeries}
                          height={260}
                          yUnit=" W"
                          series={[
                            { key: "actual_w", color: SERIES.power, name: "Actual power", unit: "W" },
                            { key: "reference_w", color: SERIES.before, name: "Reference", unit: "W", dash: true },
                          ]}
                        />
                        <div className="mt-2 flex items-center gap-4">
                          <LegendDot color={SERIES.power} label="measured power" />
                          <LegendDot color={SERIES.before} label="reference power" />
                          <span className="ml-auto text-[11px] text-slate-400">
                            ratio = actual / reference
                          </span>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            {/* ------------------------ cleaning ------------------------- */}
            <TabsContent value="cleaning" className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Kpi label="Total cycles" value={data.cleaning_stats.cycles} sub="completed" />
                <Kpi
                  label="Avg duration"
                  value={formatNumber(data.cleaning_stats.avg_duration_s, 0)}
                  unit="s"
                  sub="per cycle"
                />
                <Kpi label="Water consumed" value={formatNumber(data.cleaning_stats.water_l, 1)} unit="L" sub="recorded total" />
                <Kpi
                  label="Actuator energy"
                  value={formatNumber(data.cleaning_stats.energy_wh, 1)}
                  unit="Wh"
                  sub="cleaning system use"
                />
                <Kpi label="Failed cycles" value={data.cleaning_stats.failed} sub="reported by device" />
                <Kpi label="Aborted cycles" value={data.cleaning_stats.aborted} sub="stopped by operator" />
                <Kpi label="Repeated within 24 h" value={data.cleaning_stats.repeated_24h} sub="possible over-cleaning" />
                <Kpi
                  label="Recovered energy"
                  value={data.power_recovery.estimated_recovered_wh != null ? formatNumber(data.power_recovery.estimated_recovered_wh, 0) : "—"}
                  unit="Wh"
                  sub={data.power_recovery.measured ? "measured" : "estimated"}
                />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Success criterion</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                    <span className="font-semibold text-slate-800">Criterion used: </span>
                    {data.cleaning_stats.success_criterion}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                    A short-term power increase alone does not prove that cleaning was necessary or successful —
                    irradiance and temperature must be comparable between the two windows, otherwise the result
                    is reported as an estimate.
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            {/* -------------------------- model -------------------------- */}
            <TabsContent value="model" className="space-y-4">
              {data.model_metrics.available ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                  <Kpi label="Accuracy" value={formatNumber((data.model_metrics.accuracy ?? 0) * 100, 1)} unit="%" />
                  <Kpi label="Precision (macro)" value={formatNumber((data.model_metrics.precision ?? 0) * 100, 1)} unit="%" />
                  <Kpi label="Recall (macro)" value={formatNumber((data.model_metrics.recall ?? 0) * 100, 1)} unit="%" />
                  <Kpi label="F1 (macro)" value={formatNumber((data.model_metrics.f1 ?? 0) * 100, 1)} unit="%" />
                  <Kpi label="Labelled samples" value={data.model_metrics.support ?? 0} sub="ground truth" />
                </div>
              ) : (
                <WarningBanner message={`Model metrics unavailable: ${data.model_metrics.note}`} />
              )}

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="secondary" size="sm">integrity</Badge> How these metrics are produced
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 text-xs leading-relaxed text-slate-600">
                    <li>• Metrics are computed by comparing model predictions against independently verified labels stored in <span className="font-mono">ground_truth_labels</span>.</li>
                    <li>• Confidence scores are never treated as correct answers; unlabeled operational predictions are excluded.</li>
                    <li>• Until expert labels are uploaded for analysed images, accuracy and F1 are intentionally reported as unavailable.</li>
                  </ul>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </>
      ) : (
        !summary.error && <EmptyState title="No analytics data" message="Adjust the date filter or start the backend in demo mode." />
      )}
    </div>
  );
}
