import { NavLink } from "react-router-dom";
import {
  Activity,
  BarChart3,
  CalendarClock,
  Cpu,
  Droplets,
  History,
  LayoutDashboard,
  Settings,
  SunMedium,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSystem } from "@/context/SystemContext";

type NavItem = { to: string; label: string; icon: typeof Activity; end?: boolean };

export const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Monitoring",
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/monitoring", label: "Live Monitoring", icon: Activity },
      { to: "/detection", label: "AI Soiling Detection", icon: SunMedium },
    ],
  },
  {
    label: "Operations",
    items: [
      { to: "/cleaning", label: "Automatic Cleaning", icon: Droplets },
      { to: "/analytics", label: "Performance Analytics", icon: BarChart3 },
      { to: "/events", label: "Event History", icon: History },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/devices", label: "Device Management", icon: Cpu },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

const EASE = "ease-[cubic-bezier(0.4,0,0.2,1)]";

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { status } = useSystem();
  const alertCount = status?.active_alerts ?? 0;

  return (
    <nav aria-label="Primary" className="flex flex-col px-2 pb-4 pt-3">
      {NAV_SECTIONS.map((section, si) => (
        <div key={section.label} className={cn(si > 0 && "mt-5")}>
          <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            {section.label}
          </p>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      "group relative flex h-10 items-center gap-3 rounded-lg pl-4 pr-3 text-[13px] font-medium transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-solar-400/70 focus-visible:ring-offset-0",
                      isActive
                        ? "bg-solar-500/12 text-solar-300"
                        : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-100",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span
                          aria-hidden="true"
                          className="absolute -left-2 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-solar-500"
                        />
                      )}
                      <item.icon
                        className={cn(
                          "h-4 w-4 shrink-0 transition-colors",
                          isActive ? "text-solar-400" : "text-slate-500 group-hover:text-slate-300",
                        )}
                      />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.to === "/events" && alertCount > 0 && (
                        <span className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-bold text-red-200 ring-1 ring-inset ring-red-500/30">
                          {alertCount > 99 ? "99+" : alertCount}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SidebarFooter() {
  const { status } = useSystem();
  return (
    <div className="mt-auto px-5 pb-4 pt-5">
      <div className="flex items-start gap-2">
        <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">Last data update</p>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {status?.last_telemetry_at ? new Date(status.last_telemetry_at).toLocaleString() : "No telemetry yet"}
          </p>
        </div>
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-slate-600">SoilingGuard v1.0 · Research build</p>
    </div>
  );
}

function RailNav() {
  const { status } = useSystem();
  const alertCount = status?.active_alerts ?? 0;

  return (
    <nav aria-label="Quick navigation" className="flex flex-col px-2 pt-3">
      {NAV_SECTIONS.map((section, si) => (
        <div key={section.label} className={cn(si > 0 && "mt-5")}>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <li key={item.to} className="mx-auto w-10">
                <NavLink
                  to={item.to}
                  end={item.end}
                  title={item.label}
                  aria-label={item.label}
                  className={({ isActive }) =>
                    cn(
                      "group relative flex h-10 w-10 items-center justify-center rounded-lg motion-reduce:transition-none",
                      `transition-[background-color,color] duration-300 ${EASE}`,
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-solar-400/70 focus-visible:ring-offset-0",
                      isActive
                        ? "bg-solar-500/12 text-solar-300"
                        : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-100",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span
                          aria-hidden="true"
                          className="absolute -left-4 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-solar-500"
                        />
                      )}
                      <item.icon
                        className={cn(
                          "h-4 w-4 shrink-0 transition-colors",
                          isActive ? "text-solar-400" : "text-slate-500 group-hover:text-slate-300",
                        )}
                      />
                      {item.to === "/events" && alertCount > 0 && (
                        <span
                          aria-hidden="true"
                          className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-navy-900"
                        />
                      )}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Always-visible slim icon rail on desktop (below the navbar, behind the overlay drawer). */
export function SidebarRail() {
  return (
    <aside
      aria-label="Quick navigation rail"
      className="fixed left-0 top-14 z-[900] hidden h-[calc(100vh-3.5rem)] w-[72px] flex-col border-r border-navy-700/70 bg-navy-900 lg:flex"
    >
      <RailNav />
    </aside>
  );
}

/**
 * Overlay drawer used at every viewport:
 * fixed, 100vh tall, parked off-screen with translateX(-100%) and slid in with .open.
 */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      {/* Overlay — dark backdrop behind the drawer (opacity-only: cheap to animate) */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={cn(
          "fixed inset-0 z-[999] bg-navy-950/65 motion-reduce:transition-none",
          `transition-opacity duration-300 ${EASE}`,
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      {/* Drawer — fixed, full height, z-index 1000; composited transform for buttery motion */}
      <aside
        id="app-sidebar"
        aria-label="Navigation menu"
        inert={!open}
        style={{ willChange: "transform" }}
        className={cn(
          "fixed left-0 top-0 z-[1000] flex h-screen w-[260px] flex-col border-r border-navy-700/70 bg-navy-900 shadow-2xl",
          "transform-gpu backface-hidden",
          `motion-reduce:transition-none transition-transform duration-300 ${EASE}`,
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-navy-700/70 px-4">
          <span className="text-sm font-semibold text-slate-100">Navigation</span>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
            className="-mr-1 flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-solar-400/70"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <NavList onNavigate={onClose} />
        </div>

        <SidebarFooter />
      </aside>
    </>
  );
}
