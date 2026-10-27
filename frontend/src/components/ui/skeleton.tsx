import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-slate-200", className)} {...props} />;
}

function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-3 w-full" />
      ))}
    </div>
  );
}

function MetricSkeleton() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-7 w-28" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="flex items-end gap-2" style={{ height }}>
        {Array.from({ length: 14 }).map((_, i) => (
          <Skeleton key={i} className="w-full" style={{ height: `${25 + ((i * 37) % 70)}%` }} />
        ))}
      </div>
    </div>
  );
}

export { Skeleton, CardSkeleton, MetricSkeleton, ChartSkeleton };
