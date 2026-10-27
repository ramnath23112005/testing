import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";

export const SERIES = {
  power: "#129257",
  voltage: "#0284c7",
  current: "#7c3aed",
  temp: "#ea580c",
  humidity: "#0891b2",
  irradiance: "#ca8a04",
  before: "#94a3b8",
  after: "#1fb36c",
  fault: "#dc2626",
};

export const PIE_COLORS = ["#129257", "#f59e0b", "#dc2626", "#0284c7", "#7c3aed", "#64748b"];

interface PayloadItem {
  value?: number | string;
  name?: string | number;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: PayloadItem[];
  label?: string | number;
  unit?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-navy-700 bg-navy-900 px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 text-[11px] font-semibold text-slate-300">{String(label ?? "")}</p>
      <ul className="space-y-0.5">
        {payload.map((p, i) => (
          <li key={i} className="flex items-center gap-2 text-slate-100">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? "#94a3b8" }} />
            <span className="text-slate-300">{p.name ?? p.dataKey}</span>
            <span className="ml-auto font-mono tabular-nums">
              {p.value === null || p.value === undefined
                ? "no data"
                : typeof p.value === "number"
                  ? Number.isInteger(p.value)
                    ? p.value
                    : p.value.toFixed(2)
                  : String(p.value)}
              {unit ?? ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TimeAxis({ dataKey = "ts" }: { dataKey?: string }) {
  return (
    <XAxis
      dataKey={dataKey}
      tick={{ fontSize: 10, fill: "#94a3b8" }}
      tickLine={false}
      axisLine={{ stroke: "#e2e8f0" }}
      minTickGap={40}
      tickFormatter={(v: string) => {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return String(v);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }}
    />
  );
}

export function ValueAxis({
  unit = "",
  domain,
  width,
}: {
  unit?: string;
  domain?: [number | "auto" | "dataMin" | "dataMax", number | "auto" | "dataMin" | "dataMax"];
  width?: number;
}) {
  return (
    <YAxis
      tick={{ fontSize: 10, fill: "#94a3b8" }}
      tickLine={false}
      axisLine={{ stroke: "#e2e8f0" }}
      width={width ?? 46}
      domain={domain ?? ["auto", "auto"]}
      tickFormatter={(v: number) => `${v}${unit}`}
    />
  );
}

export function ChartGrid() {
  return <CartesianGrid stroke="#eef2f6" strokeDasharray="3 3" vertical={false} />;
}

export function ChartFrame({ children, height = 240 }: { children: ReactNode; height?: number }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

export function TrendArea({
  data,
  color = SERIES.power,
  height = 76,
  dataKey = "power_w",
  unit = "",
}: {
  data: Record<string, number | string | null>[];
  color?: string;
  height?: number;
  dataKey?: string;
  unit?: string;
}) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
          <defs>
            <linearGradient id={`g-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.6}
            fill={`url(#g-${dataKey})`}
            isAnimationActive={false}
            connectNulls={false}
            dot={false}
            unit={unit}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MultiLineChart({
  data,
  series,
  height = 260,
  yUnit = "",
  extra,
}: {
  data: unknown[];
  series: { key: string; color: string; name: string; unit?: string; dash?: boolean }[];
  height?: number;
  yUnit?: string;
  extra?: ReactNode;
}) {
  return (
    <ChartFrame height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <ChartGrid />
        <TimeAxis />
        <ValueAxis unit={yUnit} />
        <Tooltip
          content={<ChartTooltipContent />}
          isAnimationActive={false}
        />
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={`${s.name}${s.unit ? ` (${s.unit})` : ""}`}
            stroke={s.color}
            strokeWidth={1.8}
            strokeDasharray={s.dash ? "4 3" : undefined}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
        {extra}
      </LineChart>
    </ChartFrame>
  );
}

export function BarsChart({
  data,
  dataKey,
  color = SERIES.power,
  height = 240,
  xKey = "label",
  unit = "",
  referenceLines,
}: {
  data: Record<string, string | number | null>[];
  dataKey: string;
  color?: string;
  height?: number;
  xKey?: string;
  unit?: string;
  referenceLines?: { y: number; label: string; color: string }[];
}) {
  return (
    <ChartFrame height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <ChartGrid />
        <XAxis dataKey={xKey} tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={{ stroke: "#e2e8f0" }} />
        <ValueAxis unit={unit} />
        <Tooltip content={<ChartTooltipContent unit={unit} />} cursor={{ fill: "#f1f5f9" }} isAnimationActive={false} />
        <Bar dataKey={dataKey} fill={color} radius={[3, 3, 0, 0]} isAnimationActive={false} maxBarSize={48} />
        {referenceLines?.map((r) => (
          <ReferenceLine key={r.label} y={r.y} stroke={r.color} strokeDasharray="4 3" label={{ value: r.label, fontSize: 10, fill: r.color }} />
        ))}
      </BarChart>
    </ChartFrame>
  );
}

export function DonutChart({
  data,
  height = 240,
}: {
  data: { name: string; value: number }[];
  height?: number;
}) {
  return (
    <ChartFrame height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius={52}
          outerRadius={82}
          paddingAngle={2}
          isAnimationActive={false}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip content={<ChartTooltipContent />} isAnimationActive={false} />
        <Legend
          verticalAlign="bottom"
          iconType="circle"
          wrapperStyle={{ fontSize: 11, color: "#475569" }}
        />
      </PieChart>
    </ChartFrame>
  );
}

export function StackedBars({
  data,
  keys,
  height = 240,
}: {
  data: Record<string, string | number>[];
  keys: { key: string; color: string; name: string }[];
  height?: number;
}) {
  return (
    <ChartFrame height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <ChartGrid />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={{ stroke: "#e2e8f0" }} />
        <ValueAxis />
        <Tooltip content={<ChartTooltipContent />} cursor={{ fill: "#f1f5f9" }} isAnimationActive={false} />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
        {keys.map((k) => (
          <Bar key={k.key} dataKey={k.key} name={k.name} stackId="a" fill={k.color} isAnimationActive={false} />
        ))}
      </BarChart>
    </ChartFrame>
  );
}

export function LegendDot({ color, label, className }: { color: string; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px] text-slate-500", className)}>
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
