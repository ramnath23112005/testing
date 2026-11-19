import * as React from "react";
import { Download, History, Loader2, RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/api";
import { useAsync, useDebounced } from "@/lib/hooks";
import { formatDateTime, formatNumber } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState, PageHeader } from "@/components/shared/indicators";

const PAGE_SIZE = 15;

const statusVariant = (s: string) =>
  s === "critical" || s === "error"
    ? "destructive"
    : s === "warning"
      ? "warning"
      : s === "success"
        ? "success"
        : "info";

const prettyType = (t: string) =>
  t
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

export default function ActivityHistoryPage() {
  const { toast } = useToast();
  const [search, setSearch] = React.useState("");
  const [type, setType] = React.useState("all");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [exporting, setExporting] = React.useState(false);
  const debouncedSearch = useDebounced(search, 350);

  const query = React.useMemo(
    () => ({
      search: debouncedSearch || undefined,
      event_type: type === "all" ? undefined : type,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
      page,
      page_size: PAGE_SIZE,
    }),
    [debouncedSearch, type, from, to, page],
  );

  const list = useAsync(() => api.events(query), [JSON.stringify(query)], {
    pollMs: 30_000,
  });

  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, type, from, to]);

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const typeOptions = [
    { value: "all", label: "All activity" },
    ...(list.data?.event_types ?? []).map((t) => ({ value: t, label: prettyType(t) })),
  ];

  async function exportCsv() {
    setExporting(true);
    try {
      await api.csvDownload("/api/export/events", "activity-history.csv", {
        search: debouncedSearch || undefined,
        event_type: type === "all" ? undefined : type,
        from: query.from,
        to: query.to,
      });
      toast({ title: "Activity export ready", variant: "success" });
    } catch (e) {
      toast({ title: "Export failed", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Activity History"
        description="Record of camera captures, dust detections, power readings, cleaning cycles and verification results."
        tooltip={
          <>
            Activity is written by the system as you capture images, collect telemetry and run cleaning
            cycles. It is not an administrative audit log.
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void list.reload()}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Export CSV
            </Button>
          </>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-5">
          <div className="min-w-[220px] flex-1">
            <Label htmlFor="activity-search" className="text-[11px]">
              Search
            </Label>
            <div className="relative mt-1.5">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <Input
                id="activity-search"
                placeholder="Search activity…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>
          <div className="min-w-[190px]">
            <Label className="text-[11px]">Activity type</Label>
            <Select ariaLabel="Activity type" value={type} onValueChange={setType} options={typeOptions} className="mt-1.5" />
          </div>
          <div>
            <Label className="text-[11px]">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1.5" />
          </div>
          <div>
            <Label className="text-[11px]">To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1.5" />
          </div>
          <div className="ml-auto text-xs text-slate-500">{formatNumber(total, 0)} matching entries</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4 text-solar-600" /> Recent activity
            </CardTitle>
            <CardDescription>
              Showing page {page} of {pages}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {list.loading && !list.data ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : list.error ? (
            <ErrorState message={list.error} onRetry={list.reload} />
          ) : !list.data || list.data.items.length === 0 ? (
            <EmptyState
              icon={<History className="h-5 w-5" />}
              title="No activity matches the filters"
              message="Clear the search or widen the date range. Activity is added as captures, readings and cleaning cycles occur."
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="py-2 pr-3">Timestamp</th>
                      <th className="py-2 pr-3">Activity</th>
                      <th className="py-2 pr-3">Description</th>
                      <th className="py-2 pr-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((e) => (
                      <tr key={e.id} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="whitespace-nowrap py-2 pr-3 text-xs text-slate-600">{formatDateTime(e.ts)}</td>
                        <td className="py-2 pr-3">
                          <Badge variant="outline" size="sm">
                            {e.event_label}
                          </Badge>
                        </td>
                        <td className="max-w-xl py-2 pr-3 text-xs text-slate-700">{e.description}</td>
                        <td className="py-2 pr-3">
                          <Badge variant={statusVariant(e.status)} size="sm">
                            {e.status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex items-center justify-between">
                <p className="text-xs text-slate-500">Newest activity first.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="h-8" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <Button size="sm" variant="outline" className="h-8" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
