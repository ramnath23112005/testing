import * as React from "react";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Generic data-fetching hook with abort handling, manual reload and
 * optional polling. Never throws to the caller; errors are surfaced as text.
 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: React.DependencyList,
  options: { pollMs?: number | null; enabled?: boolean } = {},
): AsyncState<T> {
  const { pollMs = null, enabled = true } = options;
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState<boolean>(enabled);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const fnRef = React.useRef(fn);
  fnRef.current = fn;

  React.useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    let alive = true;
    setLoading(true);
    fnRef
      .current(ac.signal)
      .then((res) => {
        if (alive && !ac.signal.aborted) {
          setData(res);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!alive || ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Request failed");
      })
      .finally(() => {
        if (alive && !ac.signal.aborted) setLoading(false);
      });
    return () => {
      alive = false;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);

  React.useEffect(() => {
    if (!pollMs || !enabled) return;
    const id = window.setInterval(() => setTick((t) => t + 1), pollMs);
    return () => window.clearInterval(id);
  }, [pollMs, enabled]);

  const reload = React.useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, error, reload };
}

/** Runs a callback on an interval; pass null to pause. */
export function useInterval(callback: () => void, ms: number | null) {
  const cb = React.useRef(callback);
  cb.current = callback;
  React.useEffect(() => {
    if (ms === null) return;
    const id = window.setInterval(() => cb.current(), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

/** Debounced value for search inputs. */
export function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const id = window.setTimeout(() => setV(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return v;
}

export type RangeKey = "15m" | "1h" | "24h" | "7d" | "custom";

export const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "15m", label: "Last 15 minutes" },
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "custom", label: "Custom range" },
];

export const RANGE_POLL_MS: Record<RangeKey, number | null> = {
  "15m": 5_000,
  "1h": 15_000,
  "24h": 60_000,
  "7d": null,
  custom: null,
};
