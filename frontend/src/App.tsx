import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "@/components/ui/toast";
import { AppShell, RequireAuth } from "@/components/layout/AppShell";
import { AuthProvider } from "@/context/AuthContext";
import { SystemProvider } from "@/context/SystemContext";

import OverviewPage from "@/pages/OverviewPage";
import LiveMonitoringPage from "@/pages/LiveMonitoringPage";
import DetectionPage from "@/pages/DetectionPage";
import CleaningPage from "@/pages/CleaningPage";
import AnalyticsPage from "@/pages/AnalyticsPage";
import EventsPage from "@/pages/EventsPage";
import DevicesPage from "@/pages/DevicesPage";
import SettingsPage from "@/pages/SettingsPage";
import NotFoundPage from "@/pages/NotFoundPage";

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <TooltipProvider delayDuration={200}>
          <AuthProvider>
            <Routes>
              <Route
                element={
                  <RequireAuth>
                    <SystemProvider>
                      <AppShell />
                    </SystemProvider>
                  </RequireAuth>
                }
              >
                <Route index element={<OverviewPage />} />
                <Route path="/monitoring" element={<LiveMonitoringPage />} />
                <Route path="/detection" element={<DetectionPage />} />
                <Route path="/cleaning" element={<CleaningPage />} />
                <Route path="/analytics" element={<AnalyticsPage />} />
                <Route path="/events" element={<EventsPage />} />
                <Route path="/devices" element={<DevicesPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/home" element={<Navigate to="/" replace />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </AuthProvider>
        </TooltipProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
