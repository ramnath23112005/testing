import * as React from "react";
import { Link } from "react-router-dom";
import {
  Bell,
  ChevronDown,
  MapPinned,
  Menu,
  RefreshCw,
  ShieldCheck,
  Sun,
  UserRound,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useSystem } from "@/context/SystemContext";
import { relativeTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OperatingModeBadge } from "@/components/shared/indicators";

const GHOST_ICON =
  "relative h-9 w-9 text-slate-400 transition-colors hover:bg-white/[0.07] hover:text-slate-100 focus-visible:ring-solar-400/70 focus-visible:ring-offset-0";

function Logo() {
  return (
    <Link
      to="/"
      className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-solar-400/70"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-solar-500 to-solar-700 shadow-sm shadow-solar-900/40">
        <Sun className="h-4.5 w-4.5 text-white" />
      </span>
      <span className="hidden leading-tight sm:block">
        <span className="block text-sm font-bold tracking-tight text-slate-100">SoilingGuard</span>
        <span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
          PV Soiling &amp; Cleaning
        </span>
      </span>
    </Link>
  );
}

/** Single unified badge: operating mode (demo / hardware / cleaning / fault). */
function StatusBadge() {
  const { status, statusError } = useSystem();

  if (statusError) {
    return (
      <span
        title="The API server could not be reached. Check that the backend is running."
        className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-[10px] font-semibold tracking-wider text-red-300 ring-1 ring-inset ring-red-500/30"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
        API UNREACHABLE
      </span>
    );
  }
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-[10px] font-semibold tracking-wider text-slate-400 ring-1 ring-inset ring-white/10">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
        CONNECTING…
      </span>
    );
  }
  return <OperatingModeBadge mode={status.operating_mode} tone="dark" className="hidden sm:inline-flex" />;
}

/** Sleek context selector: location icon + borderless dropdown in a soft pill. */
function ContextSelector() {
  const { devices, selectedDeviceId, selectDevice } = useSystem();
  if (devices.length === 0) return null;
  const labelFor = (d: (typeof devices)[number]) => {
    const name =
      d.simulated && !/simulated/i.test(d.display_name) ? `${d.display_name} (simulated)` : d.display_name;
    return `${name} · ${d.location}`;
  };
  const selected = devices.find((d) => d.id === selectedDeviceId);
  return (
    <div
      title={selected ? labelFor(selected) : "Select site and PV array"}
      className="hidden h-9 min-w-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] pl-3 pr-1.5 transition-colors hover:bg-white/[0.07] md:flex md:w-[260px] lg:w-[340px]"
    >
      <MapPinned className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
      <Select
        ariaLabel="Select site and PV array"
        value={selectedDeviceId ?? ""}
        onValueChange={selectDevice}
        options={devices.map((d) => ({ value: d.id, label: labelFor(d) }))}
        className="h-7 min-w-0 flex-1 border-0 bg-transparent px-1 text-xs text-slate-200 shadow-none focus:border-transparent focus:ring-2 focus:ring-solar-400/50 [&>span]:text-slate-200 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:text-slate-500"
      />
    </div>
  );
}

function NotificationBell() {
  const { alerts, unread, markRead, markAllRead, refreshAlerts } = useSystem();
  const [open, setOpen] = React.useState(false);

  const sevCls = (s: string) =>
    s === "critical" ? "border-l-red-500" : s === "warning" ? "border-l-amber-500" : "border-l-sky-500";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Notifications, ${unread} unread`}
          title="Notifications"
          className={GHOST_ICON}
        >
          <Bell className="h-4.5 w-4.5" />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white ring-2 ring-navy-900">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5">
          <span className="text-xs font-semibold text-slate-800">Notifications</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void refreshAlerts()}
              className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-solar-600/40"
              aria-label="Refresh notifications"
              title="Refresh notifications"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void markAllRead()}
              className="rounded px-1 text-[11px] font-medium text-solar-700 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-solar-600/40"
            >
              Mark all read
            </button>
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {alerts.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-slate-500">No notifications.</p>
          )}
          {alerts.slice(0, 12).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                if (!a.read) void markRead(a.id);
                setOpen(false);
              }}
              className={`flex w-full flex-col gap-0.5 border-b border-slate-100 border-l-2 px-3 py-2.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-solar-600/40 ${sevCls(a.severity)} ${
                a.read ? "opacity-60" : ""
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-800">{a.title}</span>
                <Badge
                  variant={a.severity === "critical" ? "destructive" : a.severity === "warning" ? "warning" : "info"}
                  size="sm"
                >
                  {a.severity}
                </Badge>
              </span>
              <span className="text-[11px] leading-snug text-slate-500">{a.message}</span>
              <span className="text-[10px] text-slate-400">{relativeTime(a.ts)}</span>
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { user } = useAuth();
  const { status, refreshStatus, refreshDevices } = useSystem();

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-navy-700/70 bg-navy-900 px-3 sm:gap-3 sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open navigation menu"
        title="Menu"
        className={GHOST_ICON}
        onClick={onOpenMenu}
      >
        <Menu className="h-5 w-5" />
      </Button>

      <Logo />

      {/* Right: context, status and global controls */}
      <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
        <ContextSelector />
        <StatusBadge />

        <div className="hidden text-right leading-tight sm:block">
          <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-slate-500">Last update</p>
          <p className="text-[11px] text-slate-400">{relativeTime(status?.last_telemetry_at)}</p>
        </div>

        <Button
          variant="ghost"
          size="icon"
          title="Refresh status and devices"
          aria-label="Refresh status and devices"
          className={GHOST_ICON}
          onClick={() => {
            void refreshStatus();
            void refreshDevices();
          }}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>

        <NotificationBell />

        <span aria-hidden="true" className="mx-1 hidden h-6 w-px bg-white/10 sm:block" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="User menu"
              className="flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2 transition-colors hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-solar-400/70"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-solar-500 to-solar-700 text-xs font-semibold text-white ring-1 ring-white/15">
                {(user?.full_name ?? user?.username ?? "?").slice(0, 1).toUpperCase()}
              </span>
              <ChevronDown className="h-3 w-3 text-slate-500 transition-colors" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Signed in</DropdownMenuLabel>
            <div className="px-2.5 pb-2">
              <p className="text-sm font-medium text-slate-800">{user?.full_name ?? user?.username}</p>
              <p className="text-xs text-slate-500">@{user?.username}</p>
              <div className="mt-1.5">
                <Badge variant="dark" size="sm">
                  <ShieldCheck className="h-3 w-3" /> {user?.role}
                </Badge>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/settings">
                <UserRound className="h-4 w-4" /> Account settings
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
