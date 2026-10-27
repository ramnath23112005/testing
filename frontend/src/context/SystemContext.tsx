import * as React from "react";
import { api } from "@/lib/api";
import type { Alert, Device, SystemStatus } from "@/lib/types";

const STATUS_POLL_MS = 10_000;
const ALERT_POLL_MS = 30_000;
const DEVICE_KEY = "sg.device";

interface SystemContextValue {
  status: SystemStatus | null;
  statusError: string | null;
  alerts: Alert[];
  unread: number;
  devices: Device[];
  devicesError: string | null;
  selectedDeviceId: string | null;
  selectedDevice: Device | null;
  selectDevice: (id: string) => void;
  refreshStatus: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  refreshAlerts: () => Promise<void>;
  markAllRead: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
}

const SystemContext = React.createContext<SystemContextValue | null>(null);

export function SystemProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<SystemStatus | null>(null);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [alerts, setAlerts] = React.useState<Alert[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [devices, setDevices] = React.useState<Device[]>([]);
  const [devicesError, setDevicesError] = React.useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = React.useState<string | null>(
    () => localStorage.getItem(DEVICE_KEY),
  );

  const refreshStatus = React.useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setStatusError(null);
      setSelectedDeviceId((prev) => {
        const next = prev && s.primary_device_id ? prev : s.primary_device_id;
        if (next && next !== prev) localStorage.setItem(DEVICE_KEY, next);
        return next ?? prev;
      });
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : "Status unavailable");
    }
  }, []);

  const refreshDevices = React.useCallback(async () => {
    try {
      const list = await api.devices();
      setDevices(list);
      setDevicesError(null);
      setSelectedDeviceId((prev) => {
        const stored = localStorage.getItem(DEVICE_KEY);
        const valid = list.find((d) => d.id === (stored ?? prev));
        const next = valid?.id ?? list[0]?.id ?? null;
        if (next) localStorage.setItem(DEVICE_KEY, next);
        return next;
      });
    } catch (e) {
      setDevicesError(e instanceof Error ? e.message : "Devices unavailable");
    }
  }, []);

  const refreshAlerts = React.useCallback(async () => {
    try {
      const res = await api.alerts();
      setAlerts(res.items);
      setUnread(res.unread);
    } catch {
      /* alert polling is non-critical */
    }
  }, []);

  const selectDevice = React.useCallback((id: string) => {
    localStorage.setItem(DEVICE_KEY, id);
    setSelectedDeviceId(id);
  }, []);

  const markRead = React.useCallback(
    async (id: string) => {
      const res = await api.markAlertRead(id);
      setAlerts(res.items);
      setUnread(res.unread);
    },
    [],
  );

  const markAllRead = React.useCallback(async () => {
    const res = await api.markAllAlertsRead();
    setAlerts(res.items);
    setUnread(res.unread);
  }, []);

  React.useEffect(() => {
    void refreshStatus();
    void refreshDevices();
    void refreshAlerts();
    const t1 = window.setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    const t2 = window.setInterval(() => void refreshAlerts(), ALERT_POLL_MS);
    const t3 = window.setInterval(() => void refreshDevices(), 60_000);
    return () => {
      window.clearInterval(t1);
      window.clearInterval(t2);
      window.clearInterval(t3);
    };
  }, [refreshStatus, refreshDevices, refreshAlerts]);

  const selectedDevice = React.useMemo(
    () => devices.find((d) => d.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );

  const value = React.useMemo(
    () => ({
      status,
      statusError,
      alerts,
      unread,
      devices,
      devicesError,
      selectedDeviceId,
      selectedDevice,
      selectDevice,
      refreshStatus,
      refreshDevices,
      refreshAlerts,
      markAllRead,
      markRead,
    }),
    [
      status,
      statusError,
      alerts,
      unread,
      devices,
      devicesError,
      selectedDeviceId,
      selectedDevice,
      selectDevice,
      refreshStatus,
      refreshDevices,
      refreshAlerts,
      markAllRead,
      markRead,
    ],
  );

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}

export function useSystem() {
  const ctx = React.useContext(SystemContext);
  if (!ctx) throw new Error("useSystem must be used within SystemProvider");
  return ctx;
}
