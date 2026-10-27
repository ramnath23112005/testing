"""Application configuration loaded from environment variables / .env file."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BASE_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "SoilingGuard API"
    app_version: str = "1.0.0"
    environment: str = "development"
    debug: bool = False

    # database: sqlite fallback when PostgreSQL is not available
    database_url: str = f"sqlite:///{BASE_DIR / 'soilingguard.db'}"

    # security
    secret_key: str = "change-me-in-production-use-openssl-rand-hex-32"
    access_token_expire_minutes: int = 720
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173"

    # seed account (single user - the frontend signs itself in automatically)
    seed_ramnath_username: str = "Ramnath"
    seed_ramnath_password: str = "Ramnath"

    # demo / simulation
    demo_mode: bool = True
    simulator_enabled: bool = True
    simulator_tick_s: float = 30.0
    seed_history_days: int = 30

    # AI
    model_path: str = str(BASE_DIR / "models" / "soiling_mobilenetv3.pt")
    model_metadata_path: str = str(BASE_DIR / "models" / "model_metadata.json")
    max_upload_mb: int = 8
    gradcam_enabled: bool = True

    # storage
    media_dir: str = str(BASE_DIR / "media")

    # IoT / MQTT
    mqtt_host: str = ""
    mqtt_port: int = 1883
    mqtt_username: str = ""
    mqtt_password: str = ""
    mqtt_topic_prefix: str = "soilingguard"
    mqtt_enabled: bool = False

    # limits
    login_rate_limit_per_minute: int = 10
    predict_rate_limit_per_minute: int = 12
    cleaning_rate_limit_per_minute: int = 6

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}
