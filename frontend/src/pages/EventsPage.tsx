import * as React from "react";
import { Download, Eye, History, Loader2, RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/api";
import { useAsync, useDebounced } from "@/lib/hooks";
import { cn, formatDateTime, formatNumber } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState, PageHeader } from "@/components/shared/indicators";
import type { EventItem } from "@/lib/types";

const PAGE_SIZE = 15;

const statusVariant = (s: string) =>
  s === "critical" || s === "error"
    ? "destructive"
    : s === "warning"
      ? "warning"
      : s === "success"
        ? "success"
        : "info";

export default function EventsPage() {
  const { toast } = useToast();
  const [search, setSearch] = React.useState("");
  const [type, setType] = React.useState("all");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [detail, setDetail] = React.useState<EventItem | null>(null);
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
    { value: "all", label: "All event types" },
    ...(list.data?.event_types ?? []).map((t) => ({ value: t, label: t.replace(/_/g, " ") })),
  ];

  async function exportCsv() {
    setExporting(true);
    try {
      await api.csvDownload("/api/export/events", "events.csv", {
        search: debouncedSearch || undefined,
        event_type: type === "all" ? undefined : type,
        from: query.from,
        to: query.to,
      });
      toast({ title: "Event export ready", variant: "success" });
    } catch (e) {
      toast({ title: "Export failed", description: e instanceof Error ? e.message : "", variant: "error" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Event History & Audit Log"
        description="Searchable, append-only record of captures, predictions, cleaning commands, faults and configuration changes."
        tooltip={
          <>
            Audit records are append-only for normal users; administrative actions are restricted and retained
            for incident investigation.
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
            <Label htmlFor="event-search" className="text-[11px]">
              Search
            </Label>
            <div className="relative mt-1.5">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <Input
                id="event-search"
                placeholder="Description, device, actor, reference…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>
          <div className="min-w-[190px]">
            <Label className="text-[11px]">Event type</Label>
            <Select ariaLabel="Event type" value={type} onValueChange={setType} options={typeOptions} className="mt-1.5" />
          </div>
          <div>
            <Label className="text-[11px]">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1.5" />
          </div>
          <div>
            <Label className="text-[11px]">To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1.5" />
          </div>
          <div className="ml-auto text-xs text-slate-500">{formatNumber(total, 0)} matching events</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4 text-solar-600" /> Events
            </CardTitle>
            <CardDescription>Showing page {page} of {pages}</CardDescription>
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
              title="No events match the filters"
              message="Clear the search or widen the date range. Demo mode generates events as you use the application."
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="py-2 pr-3">Timestamp</th>
                      <th className="py-2 pr-3">Event type</th>
                      <th className="py-2 pr-3">Device</th>
                      <th className="py-2 pr-3">Description</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Actor</th>
                      <th className="py-2 pr-3">Reference</th>
                      <th className="py-2 pr-3 text-right">Detail</th>
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
                        <td className="py-2 pr-3 font-mono text-[11px] text-slate-500">{e.device_id ?? "—"}</td>
                        <td className="max-w-md truncate py-2 pr-3 text-xs text-slate-700" title={e.description}>
                          {e.description}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant={statusVariant(e.status)} size="sm">
                            {e.status}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3 text-xs text-slate-600">{e.actor}</td>
                        <td className="py-2 pr-3 font-mono text-[11px] text-slate-500">{e.reference ?? "—"}</td>
                        <td className="py-2 pr-3 text-right">
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setDetail(e)}>
                            <Eye className="h-3.5 w-3.5" /> View
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex items-center justify-between">
                <p className="text-xs text-slate-500">
                  Events are append-only. Records are retained per the configured data-retention policy.
                </p>
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

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Event detail</DialogTitle>
            <DialogDescription>{detail && detail.event_label}</DialogDescription>
          </DialogHeader>
          {detail && (
            <dl className="grid grid-cols-3 gap-3 text-xs">
              <div>
                <dt className="text-slate-500">Timestamp</dt>
                <dd className="mt-0.5 font-medium text-slate-800">{formatDateTime(detail.ts)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Status</dt>
                <dd className="mt-0.5">
                  <Badge variant={statusVariant(detail.status)} size="sm">
                    {detail.status}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Actor</dt>
                <dd className="mt-0.5 font-medium text-slate-800">{detail.actor}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Device</dt>
                <dd className="mt-0.5 font-mono text-[11px] text-slate-700">{detail.device_id ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Reference</dt>
                <dd className="mt-0.5 font-mono text-[11px] text-slate-700">{detail.reference ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Event type</dt>
                <dd className="mt-0.5 font-mono text-[11px] text-slate-700">{detail.event_type}</dd>
              </div>
              <div className="col-span-3">
                <dt className="text-slate-500">Description</dt>
                <dd className={cn("mt-0.5 leading-relaxed text-slate-700")}>{detail.description}</dd>
              </div>
              <div className="col-span-3">
                <dt className="text-slate-500">Record ID</dt>
                <dd className="mt-0.5 font-mono text-[11px] text-slate-600">{detail.id}</dd>
              </div>
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
