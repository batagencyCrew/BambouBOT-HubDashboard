from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from .. import alerts, services
from ..auth import require
from ..permissions import Principal

router = APIRouter(prefix="/api")


@router.get("/overview")
def overview(request: Request, principal: Principal = Depends(require("sites:view"))):
    app = request.app
    db = app.state.db
    sites = [services.site_summary(app, s) for s in services.visible_sites(db, principal)]
    ids = [s["id"] for s in sites]
    today = db.query("SELECT currency, sum(amount) AS total FROM cost_events WHERE site_id = ANY(%s::uuid[]) "
                     "AND ts >= date_trunc('day', now()) GROUP BY currency", (ids,))
    errors = db.one("SELECT count(*) AS n FROM event_logs WHERE site_id = ANY(%s::uuid[]) AND level >= 4 "
                    "AND ts > now() - interval '24 hours'", (ids,))
    open_alerts = db.query("SELECT a.*, s.name AS site_name FROM alerts a LEFT JOIN sites s ON s.id=a.site_id "
                           "WHERE a.status IN ('open','acknowledged') AND (a.site_id IS NULL OR a.site_id = ANY(%s::uuid[])) "
                           "ORDER BY a.opened_at DESC LIMIT 20", (ids,))
    totals = {"sites": len(sites), "online": sum(s["health"] != "offline" for s in sites),
              "healthy": sum(s["health"] == "healthy" for s in sites),
              "degraded": sum(s["health"] == "degraded" for s in sites),
              "offline": sum(s["health"] == "offline" for s in sites),
              "workers_running": sum(s["workers"].get("running", 0) for s in sites),
              "workers_idle": sum(s["workers"].get("idle", 0) for s in sites),
              "workers_error": sum(s["workers"].get("error", 0) for s in sites),
              "errors_24h": errors["n"] if errors else 0,
              "cost_today": {r["currency"]: float(r["total"]) for r in today}}
    return {"totals": totals, "sites": sites,
            "alerts": [alerts.alert_view(a, a["site_name"] or "") for a in open_alerts]}
