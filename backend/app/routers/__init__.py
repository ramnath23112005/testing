"""API routers (all endpoints are mounted under /api unless noted)."""

from . import ai, alerts, analytics, auth, cleaning, decision, devices, events, export, settings, system, ws  # noqa: F401

__all__ = [
    "ai",
    "alerts",
    "analytics",
    "auth",
    "cleaning",
    "decision",
    "devices",
    "events",
    "export",
    "settings",
    "system",
    "ws",
]
