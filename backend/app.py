"""Production entrypoint: uvicorn backend.app:app from the project root."""

from .hub.app import create_app

app = create_app()
