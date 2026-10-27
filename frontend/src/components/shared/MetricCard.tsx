import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/tooltip";
import { SourceBadge } from "@/components/shared/indicators";
import { TrendArea } from "@/components/charts/chartkit";
import type { DataSource } from "@/lib/types";

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  unit?: string;
  tooltip: ReactNode;
  delta?: number | null;
  deltaLabel?: string;
  source?: DataSource | "none";
  spark?: { data: Record<string, number | string | null>[]; dataKey: string; color?: string };
  tone?: "default" | "warning" | "danger" | "muted";
  icon?: ReactNode;
  footer?: ReactNode;
}

export function MetricCard({
  label,
  value,
  unit,
  tooltip,
  delta,
  deltaLabel = "vs previous period",
  source,
  spark,
  tone = "default",
  icon,
  footer,
}: MetricCardProps) {
  const showDelta = delta !== undefined;
  const positive = (delta ?? 0) >= 0;
  const empty = value === null || value === undefined || value === "" || value === "—";
  const toneCls =
    tone === "danger"
      ? "text-red-600"
      : tone === "warning"
        ? "text-amber-600"
        : tone === "muted"
          ? "text-slate-500"
          : "text-slate-900";

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {source && source !== "none" && <SourceBadge source={source} />}
          <InfoTip content={tooltip} label={`What is ${label}?`} />
          {icon}
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div className={cn("min-w-0", !empty && toneCls)}>
          <div className="flex items-baseline gap-1">
            {empty ? (
              <span className="text-sm font-medium text-slate-500">No data</span>
            ) : (
              <span className="truncate text-[26px] font-bold leading-none tracking-tight">{value}</span>
            )}
            {!empty && unit && <span className="text-[13px] font-medium text-slate-500">{unit}</span>}
          </div>
          {showDelta && (
            <div className="mt-1.5 flex items-center gap-1 text-[11px]">
              {delta === null || delta === undefined || Number.isNaN(delta) ? (
                <span className="inline-flex items-center gap-0.5 text-slate-500">
                  <Minus className="h-3 w-3" /> no comparison
                </span>
              ) : (
                <span
                  className={cn(
                    "inline-flex items-center gap-0.5 font-semibold",
                    positive ? "text-emerald-600" : "text-red-600",
                  )}
                >
                  {positive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                  {Math.abs(delta).toFixed(1)}%
                </span>
              )}
              <span className="text-slate-500">{deltaLabel}</span>
            </div>
          )}
        </div>
        {spark && spark.data.length > 1 && (
          <div className="w-24 shrink-0">
            <TrendArea data={spark.data} dataKey={spark.dataKey} color={spark.color} height={52} />
          </div>
        )}
      </div>

      {footer && <p className="mt-3 text-[11px] text-slate-500">{footer}</p>}
    </Card>
  );
}
