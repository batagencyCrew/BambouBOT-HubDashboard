"""FastAPI application factory for the Bambou hub."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .auth import Auth
from .config import Settings
from .db import Database
from .security import SecretBox

LOG = logging.getLogger("hub")


def create_app(*, settings: Settings | None = None, db: Database | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    database = db or Database(settings.database_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database.open()
        app.state.migrations = database.migrate()
        database.ensure_partitions()
        app.state.realtime.startup()
        if settings.background_tasks:
            from .tasks import start_tasks
            app.state.tasks = start_tasks(app)
        try:
            yield
        finally:
            if getattr(app.state, "tasks", None):
                app.state.tasks.stop()
            app.state.realtime.shutdown()
            database.close()

    app = FastAPI(title="Bambou Hub", version=__version__, docs_url=None, redoc_url=None,
                  openapi_url=None, lifespan=lifespan)
    app.state.settings = settings
    app.state.db = database
    app.state.secrets = SecretBox(settings.secret_key)
    app.state.auth = Auth(app)

    from .realtime import Realtime
    app.state.realtime = Realtime(app)
    from .backups import BackupService
    app.state.backups = BackupService(app)

    from .routers import auth as auth_routes, sites as site_routes, users as user_routes, \
        telemetry as telemetry_routes, configfiles as config_routes, backups as backup_routes, \
        alerts as alert_routes, agent as agent_routes, audit as audit_routes, overview as overview_routes, \
        bot as bot_routes
    from . import compat_v1
    for module in (auth_routes, site_routes, user_routes, telemetry_routes, config_routes,
                   backup_routes, alert_routes, bot_routes, agent_routes, compat_v1, audit_routes, overview_routes):
        app.include_router(module.router)
    app.add_api_websocket_route("/ws/site", app.state.realtime.site_socket)
    app.add_api_websocket_route("/ws/bot", app.state.realtime.bot_socket)

    @app.middleware("http")
    async def headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-store"
        return response

    origins = [o.strip() for o in _env("HUB_CORS_ORIGINS", "").split(",") if o.strip()]
    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True,
                           allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                           allow_headers=["Authorization", "Content-Type"])

    @app.get("/api/health")
    def health():
        row = database.one("SELECT 1 AS ok")
        return {"status": "ok" if row else "degraded", "version": __version__}

    _mount_frontend(app, settings)
    return app


def _env(name: str, default: str) -> str:
    import os
    return os.environ.get(name, default)


def _mount_frontend(app: FastAPI, settings: Settings):
    root = settings.frontend_dir or Path(__file__).resolve().parents[1] / "frontend" / "dist"
    root = Path(root).resolve()

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path == "api" or path.startswith("api/") or path.startswith("ws/"):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        target = (root / path).resolve()
        if not target.is_relative_to(root):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        if target.is_file():
            return FileResponse(target)
        if path.startswith("assets/") or Path(path).suffix:
            return JSONResponse({"detail": "Not found"}, status_code=404)
        index = root / "index.html"
        if index.is_file():
            return FileResponse(index)
        return JSONResponse({"detail": "Frontend not built"}, status_code=404)
