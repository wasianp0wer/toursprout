"""Passenger entry point (cPanel "Setup Python App" is WSGI-only).

FastAPI is ASGI, so it is bridged with a2wsgi. The bridge does not run the
ASGI lifespan, which is why `create_app` sets `app.state.cfg` in its body.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

from a2wsgi import ASGIMiddleware  # noqa: E402

from app.main import app  # noqa: E402

application = ASGIMiddleware(app)
