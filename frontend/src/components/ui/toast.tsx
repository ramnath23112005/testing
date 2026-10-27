import * as React from "react";
import { X, CheckCircle2, AlertTriangle, Info, AlertOctagon } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "default" | "success" | "warning" | "error";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: Variant;
}

interface ToastContextValue {
  toast: (t: { title: string; description?: string; variant?: Variant }) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const icons: Record<Variant, React.ReactNode> = {
  default: <Info className="h-4 w-4 text-sky-600" />,
  success: <CheckCircle2 className="h-4 w-4 text-emerald-600" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-600" />,
  error: <AlertOctagon className="h-4 w-4 text-red-600" />,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const counter = React.useRef(0);

  const dismiss = React.useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback(
    ({ title, description, variant = "default" }: { title: string; description?: string; variant?: Variant }) => {
      const id = ++counter.current;
      setItems((prev) => [...prev.slice(-3), { id, title, description, variant }]);
      window.setTimeout(() => dismiss(id), variant === "error" ? 7000 : 4500);
    },
    [dismiss],
  );

  const value = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-lg border bg-white p-3.5 shadow-lg",
              t.variant === "error" && "border-red-200",
              t.variant === "warning" && "border-amber-200",
              t.variant === "success" && "border-emerald-200",
              t.variant === "default" && "border-slate-200",
            )}
          >
            <div className="mt-0.5">{icons[t.variant]}</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-800">{t.title}</p>
              {t.description && <p className="mt-0.5 text-xs text-slate-500 break-words">{t.description}</p>}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
              className="rounded p-0.5 text-slate-400 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
