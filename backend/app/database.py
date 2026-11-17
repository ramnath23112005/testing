"""SQLAlchemy engine/session setup supporting PostgreSQL and SQLite fallback."""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings

settings = get_settings()

connect_args: dict = {}
if settings.database_url.startswith("sqlite"):
    connect_args = {"check_same_thread": False, "timeout": 30}

engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    pool_pre_ping=True,
    future=True,
)

if settings.database_url.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, _record):  # pragma: no cover
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables (migrations are handled by alembic when configured)."""
    from . import models  # noqa: F401  ensure models are registered

    Base.metadata.create_all(bind=engine)
    _lightweight_migrations()


def _lightweight_migrations() -> None:
    """Add columns that were introduced after the first deployment.

    `create_all` never alters existing tables, so a deployment upgraded in place
    (SQLite on Render, or a local dev database) would otherwise be missing the
    newer telemetry columns. These ALTERs are safe on SQLite and PostgreSQL.
    """
    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    if "telemetry_readings" not in inspector.get_table_names():
        return
    columns = {c["name"] for c in inspector.get_columns("telemetry_readings")}
    if "light_level" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE telemetry_readings ADD COLUMN light_level FLOAT"))
