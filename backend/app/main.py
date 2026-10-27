"""FastAPI application entrypoint.

Run with:  uvicorn app.main:app --host 127.0.0.1 --port 8000  (from backend/)
"""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .database import SessionLocal, init_db
from .routers import (
    ai,
    alerts,
    analytics,
    auth,
    cleaning,
    decision,
    devices,
    events,
    export,
    system,
    ws,
)
from .routers import settings as settings_router
from .seed import seed_all
from .services.cleaning_service import cleaning_service
from .services.demo_simulator import simulator
from .services.inference import classifier
from .services.mqtt_adapter import mqtt_adapter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
logger = logging.getLogger("soilingguard")
settings = get_settings()

_auto_stop = threading.Event()


def _ensure_media_dir() -> str:
    media = Path(settings.media_dir)
    media.mkdir(parents=True, exist_ok=True)
    return str(media)


def _auto_cleaning_monitor() -> None:
    """Background guard for policy=automatic. Every safety check is re-run server-side."""
    from .models import Device
    from .services import decision_engine
    from .services.settings_service import load_settings
    from .services.system_service import resolve_device_id

    while not _auto_stop.wait(60):
        db = SessionLocal()
        try:
            cfg = load_settings(db)
            if not cfg.get("auto_cleaning_enabled") or cfg.get("policy") != "automatic":
                continue
            device_id = resolve_device_id(db, None)
            if not device_id:
                continue
            result = decision_engine.evaluate(db, device_id, persist=True)
            if result.action != "cleaning_required":
                continue
            device = db.get(Device, device_id)
            if device is None:
                continue
            can, why = cleaning_service.can_start(db, device, cfg)
            if not can:
                logger.info("Auto-cleaning withheld: %s", why)
                continue
            cleaning_service.start(
                db,
                device_id,
                actor="system:auto",
                reason=f"Automatic policy: {result.action} (confidence {result.confidence:.0%})",
                trigger="automatic",
            )
            logger.info("Automatic cleaning started for %s", device_id)
        except Exception:  # pragma: no cover - keep the monitor alive
            logger.exception("auto-cleaning monitor iteration failed")
        finally:
            db.close()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    media = Path(settings.media_dir)
    media.mkdir(parents=True, exist_ok=True)

    init_db()
    db = SessionLocal()
    try:
        info = seed_all(db)
        logger.info("Seed complete: %s", info)
    finally:
        db.close()

    simulator._session_factory = SessionLocal
    simulator.start()
    logger.info("Demo simulator running=%s (demo_mode=%s)", simulator.running, settings.demo_mode)

    model_ok = classifier.load()
    logger.info("AI model available=%s (%s)", model_ok, classifier.load_error or "ready")

    mqtt_adapter.start()

    _auto_stop.clear()
    monitor = threading.Thread(target=_auto_cleaning_monitor, name="auto-clean-monitor", daemon=True)
    monitor.start()

    yield

    _auto_stop.set()
    simulator.stop()
    mqtt_adapter.stop()
    logger.info("Shutdown complete")


def create_app() -> FastAPI:
    app = FastAPI(
        title="SoilingGuard API",
        description=(
            "AI-assisted solar panel soiling detection and condition-based automatic cleaning. "
            "Simulated data is explicitly labelled; real actuator commands are protected by "
            "interlocks, cooldowns, watchdog limits and role checks."
        ),
        version=settings.app_version,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    for router in (auth.router, system.router, devices.router, ai.router, decision.router,
                   cleaning.router, analytics.router, events.router, alerts.router,
                   settings_router.router, export.router):
        app.include_router(router)
    app.include_router(ws.router)

    app.mount("/media", StaticFiles(directory=_ensure_media_dir()), name="media")

    @app.get("/", include_in_schema=False)
    def root():
        return {
            "name": settings.app_name,
            "version": settings.app_version,
            "docs": "/docs",
            "health": "/api/health",
            "time": datetime.now(timezone.utc).isoformat(),
        }

    return app


app = create_app()
