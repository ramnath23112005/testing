import * as React from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar, SidebarRail } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";

export function AppShell() {
  const [navOpen, setNavOpen] = React.useState(false);
  const mainRef = React.useRef<HTMLElement>(null);
  const location = useLocation();

  React.useEffect(() => {
    setNavOpen(false);
    mainRef.current?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  React.useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    <div className="h-screen w-full overflow-hidden bg-surface">
      {/* Always-visible slim icon rail (desktop) */}
      <SidebarRail />

      {/* Overlay drawer (fixed, translateX toggled) */}
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />

      {/* Main content wrapper: viewport-sized, scrolls internally */}
      <main ref={mainRef} className="h-full w-full overflow-y-auto">
        <Topbar onOpenMenu={() => setNavOpen(true)} />
        <div className="lg:pl-[72px]">
          <div className="mx-auto max-w-[1600px] px-3 py-5 sm:px-5 sm:py-6">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}

export function RequireAuth({ children }: { children?: React.ReactNode }) {
  const { user, token, initializing, authError, retry } = useAuth();

  if (initializing) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-solar-600" />
          <p className="text-xs text-slate-500">Signing you in…</p>
        </div>
      </div>
    );
  }

  if (!token || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface px-4">
        <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-base font-semibold text-slate-900">Automatic sign-in failed</h1>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {authError ?? "Could not reach the API server. Check that the backend is running."}
          </p>
          <Button className="mt-5 w-full" onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return <>{children ?? <Outlet />}</>;
}
