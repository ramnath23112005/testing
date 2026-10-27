import * as React from "react";
import { AlertOctagon, AlertTriangle, Inbox, Info, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/tooltip";
import type { DataSource, OperatingMode } from "@/lib/types";

export function PageHeader({
  title,
  description,
  actions,
  tooltip,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  tooltip?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900 sm:text-xl">{title}</h1>
          {tooltip && <InfoTip content={tooltip} label={`About ${title}`} />}
        </div>
        {description && <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-slate-500 sm:text-sm">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <div className="mb-3 rounded-full bg-slate-100 p-3 text-slate-400">{icon ?? <Inbox className="h-5 w-5" />}</div>
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-500">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border border-red-200 bg-red-50 px-6 py-10 text-center"
    >
      <AlertOctagon className="mb-3 h-6 w-6 text-red-500" />
      <p className="text-sm font-semibold text-red-800">{title}</p>
      <p className="mt-1 max-w-lg break-words text-xs leading-relaxed text-red-700">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </Button>
      )}
    </div>
  );
}

export function WarningBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border-l-[3px] border-amber-500 bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-900/90 shadow-sm">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" />
      <p>{message}</p>
    </div>
  );
}

export function InfoBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border-l-[3px] border-sky-500 bg-sky-50/70 px-3 py-2 text-[11px] leading-relaxed text-sky-900/90 shadow-sm">
      <Info className="mt-px h-3.5 w-3.5 shrink-0 text-sky-600" />
      <p>{message}</p>
    </div>
  );
}

const modeStyles: Record<OperatingMode, { dot: string; light: string; dark: string }> = {
  "DEMO MODE": { dot: "bg-sky-500", light: "bg-sky-50 text-sky-700 ring-sky-500/30", dark: "bg-sky-500/15 text-sky-200 ring-sky-500/40" },
  "HARDWARE CONNECTED": { dot: "bg-solar-500", light: "bg-solar-50 text-solar-700 ring-solar-600/30", dark: "bg-solar-500/15 text-solar-300 ring-solar-500/40" },
  "HARDWARE OFFLINE": { dot: "bg-slate-400", light: "bg-slate-100 text-slate-600 ring-slate-500/25", dark: "bg-slate-500/15 text-slate-300 ring-slate-400/30" },
  "AI MODEL UNAVAILABLE": { dot: "bg-amber-500", light: "bg-amber-50 text-amber-700 ring-amber-600/30", dark: "bg-amber-500/15 text-amber-300 ring-amber-500/40" },
  "CLEANING IN PROGRESS": { dot: "bg-cyan-500", light: "bg-cyan-50 text-cyan-700 ring-cyan-600/30", dark: "bg-cyan-500/15 text-cyan-200 ring-cyan-500/40" },
  "FAULT DETECTED": { dot: "bg-red-500", light: "bg-red-50 text-red-700 ring-red-500/35", dark: "bg-red-500/15 text-red-300 ring-red-500/50" },
};

/** Operating mode pill. `tone="light"` for white cards, `tone="dark"` for the navy chrome. */
export function OperatingModeBadge({
  mode,
  tone = "light",
  className,
}: {
  mode: OperatingMode;
  tone?: "light" | "dark";
  className?: string;
}) {
  const s = modeStyles[mode] ?? modeStyles["HARDWARE OFFLINE"];
  return (
    <span
      title={`Operating mode: ${mode}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wider ring-1 ring-inset",
        tone === "dark" ? s.dark : s.light,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {mode}
    </span>
  );
}

const sourceLabels: Record<DataSource, { label: string; cls: string; title: string }> = {
  measured: {
    label: "Measured",
    cls: "bg-emerald-50 text-emerald-700",
    title: "Values reported by a connected hardware sensor.",
  },
  simulated: {
    label: "Simulated",
    cls: "bg-[#eff6ff] text-[#2563eb]",
    title: "Simulated telemetry produced by the built-in demo simulator. No hardware is involved.",
  },
  estimated: {
    label: "Estimated",
    cls: "bg-orange-50 text-orange-700",
    title: "Derived or estimated value, not a direct measurement.",
  },
  demo: {
    label: "Demo",
    cls: "bg-violet-50 text-violet-700",
    title: "Static demo dataset used for demonstration without hardware.",
  },
};

/** Subtle data-source status pill that must appear next to every reading. */
export function SourceBadge({ source, className }: { source: DataSource; className?: string }) {
  const s = sourceLabels[source] ?? sourceLabels.simulated;
  return (
    <span
      title={s.title}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]",
        s.cls,
        className,
      )}
    >
      {s.label}
    </span>
  );
}

export function ClassBadge({ value, label }: { value: string; label?: string }) {
  const map: Record<string, { variant: "success" | "warning" | "destructive" | "info" | "secondary"; text: string }> = {
    clean: { variant: "success", text: label ?? "Clean" },
    lightly_dusty: { variant: "warning", text: label ?? "Lightly dusty" },
    heavily_dusty: { variant: "destructive", text: label ?? "Heavily dusty" },
    bird_dropping: { variant: "destructive", text: label ?? "Bird dropping" },
    unknown: { variant: "secondary", text: label ?? "Unknown" },
  };
  const c = map[value] ?? { variant: "secondary" as const, text: label ?? value };
  return <Badge variant={c.variant}>{c.text}</Badge>;
}

export function KpiValue({
  value,
  unit,
  size = "lg",
  muted = false,
}: {
  value: React.ReactNode;
  unit?: string;
  size?: "sm" | "lg";
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1">
      <span
        className={cn(
          "font-semibold tabular-nums tracking-tight",
          size === "lg" ? "text-2xl" : "text-lg",
          muted ? "text-slate-400" : "text-slate-900",
        )}
      >
        {value}
      </span>
      {unit && <span className="text-xs font-medium text-slate-400">{unit}</span>}
    </div>
  );
}
