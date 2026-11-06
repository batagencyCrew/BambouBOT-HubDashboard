# Hub API reference (v2)

Base `/api`. Dashboard and bot calls authenticate with a **session cookie** (dashboard)
or the **bot service token** plus `X-Bot-User: <platform>:<id>` (bot). Agent calls use
`Authorization: Bearer <site token>` only under `/api/agent/*` and `/ws/site`.
All errors are `{"detail": "..."}`. Timestamps are ISO 8601 UTC.

## Auth — `/api/auth`

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/login` `{username,password}` | sets HttpOnly cookie; returns user + expiry |
| POST | `/auth/logout` | revokes the session server-side |
| GET | `/auth/me` | current user, role, permissions, scope |
| POST | `/auth/password` `{current_password,new_password}` | revokes all sessions |
| GET | `/auth/sessions` · DELETE `/auth/sessions/{id}` | list / revoke sessions |
| GET | `/auth/catalog` | all permission names and role defaults |

## Sites — `/api/sites`

`{site_ref}` accepts id, slug, or (case-insensitive) name — bots use names.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/sites` | sites:view |
| POST | `/sites` `{name,slug?,url?,description?}` → `{site, agent_token}` | sites:create |
| GET | `/sites/{ref}` | sites:view |
| PATCH | `/sites/{ref}` `{name?,url?,description?,crash_restart?}` | sites:edit |
| DELETE | `/sites/{ref}?confirm=<slug>` | sites:delete |
| GET | `/sites/{ref}/tokens` · POST `?revoke_existing=` → `{agent_token}` | sites:create |
| GET | `/sites/{ref}/workers?include_stale=` | sites:view |
| GET | `/sites/{ref}/workers/{worker_id}/samples?period=24h` | sites:view |
| POST | `/sites/{ref}/commands` `{action,args}` | per action (see below) |
| GET | `/sites/{ref}/commands?limit=` | sites:view |
| GET | `/sites/{ref}/stats?period=24h` | sites:view |

Site summary: `{id, slug, name, url, description, desired_state, crash_restart, health:
healthy|degraded|offline, online, last_seen_at, workers: {running,idle,error,stopped,
starting,unknown}, worker_total, host, process, agent_version, capabilities}`.

Commands: `start stop restart` (control:lifecycle), `pause resume` (control:pause),
`set_workers {count}` (control:workers), `reload_config` (config:edit),
`custom:<name> {args}` (control:custom), `backup` (backups:request).
Response: `{id, action, args, status, created_at, delivered_at, completed_at, result,
source, site_name, agent_online}`. Statuses: `pending delivered running completed failed
superseded`.

## Overview — `/api/overview`

`{totals:{sites,online,healthy,degraded,offline,workers_running,workers_idle,
workers_error,errors_24h,cost_today:{USD:n}}, sites:[summary], alerts:[alert]}`

## Logs & metrics

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/logs?site=&worker=&level=debug&q=&before_id=&since=&until=&limit=` | keyset paginated; `next_before_id` |
| GET | `/sites/{ref}/metrics?period=` | names, kinds, sample counts |
| GET | `/sites/{ref}/metrics/{name}?period=&worker=` | bucketed series |
| GET | `/costs?site=&period=&group_by=day|provider|category|site|worker` | totals per currency |
| GET | `/costs/events?site=&limit=` | individual cost entries |
| GET | `/balances?site=` | latest per provider; `low` flag |
| GET | `/sites/{ref}/proxy-health?period=` | per proxy: observations, ok/slow/blocked/auth/timeout, success_rate, last_state, health |

## Config files — `/api/sites/{ref}/files`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/files` | sites:view |
| POST | `/files` `{path,format?,content,secret_keys}` | config:edit |
| GET | `/files/content?path=&reveal=` | sites:view / secrets:reveal |
| PUT | `/files/content?path=` `{content,base_revision,format?,secret_keys?}` | config:edit |
| PATCH | `/files/content?path=` `{base_revision,set,delete,add_proxies,remove_proxies}` | config:edit |
| POST | `/files/validate?path=` `{content}` | sites:view |
| DELETE | `/files?path=` | config:edit |
| GET | `/files/history?path=` · `/files/history/{id}?reveal=` | sites:view |
| POST | `/files/restore?path=&revision=` | config:edit |

File view: `{path, format, revision, applied_revision, applied_at, apply_error, in_sync,
sha256, secret_keys, updated_at, content, parsed, parse_error, revealed}`.
`content` is masked unless `reveal=true`; `parsed` is the structured view (env items,
proxy entries, JSON document). Writes return the masked view. `409` when
`base_revision` is stale.

## Backups

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/backup-remotes` | backups:manage |
| GET/POST/PUT/DELETE | `/backup-destinations[/{id}]` | view / backups:manage |
| GET/PUT | `/sites/{ref}/backups/config` | view / backups:manage |
| POST | `/sites/{ref}/backups/request` | backups:request |
| GET | `/sites/{ref}/backups?limit=` | sites:view |
| POST | `/sites/{ref}/backups/{id}/retry` | backups:manage |
| GET | `/sites/{ref}/backups/{id}/download` | backups:download |

## Alerts

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/alerts?status=active|open|acknowledged|resolved|all&site=&limit=` | sites:view |
| POST | `/alerts/{id}/ack` · `/mute` `{minutes}` · `/resolve` | alerts:ack |
| GET | `/alerts/rules` → `{kinds, rules}` | sites:view |
| POST/PUT/DELETE | `/alerts/rules[/{id}]` | alerts:manage |
| GET/PUT | `/alerts/channels` (default delivery channels) | view / alerts:manage |

Rule kinds: `site_offline worker_idle worker_error worker_silent error_spike cost_daily
balance_low backup_failed proxy_failing issue`.

## Users & bots

| Method | Path | Permission |
| --- | --- | --- |
| GET/POST | `/users` · PATCH `/users/{id}` | users:manage |
| POST | `/me/bot-link-code` → `{code}` (10 min, shown once) | sites:view |
| GET/DELETE | `/me/bot-links[/{platform}/{id}]` | sites:view |
| GET | `/bot-links` | bots:manage |
| POST | `/service-tokens/bot` → `{token}`; GET `/service-tokens`; DELETE `/service-tokens/{id}` | bots:manage |
| GET | `/audit?site=&actor=&action=&before_id=&limit=` | users:audit |

Bot-only (`Authorization: Bearer hbt_…`): `POST /api/bot/link {platform,platform_user,code}`,
`POST /api/bot/identity`, `POST /api/bot/unlink`, `GET /api/bot/deliveries`,
`POST /api/bot/deliveries/{id}`.

## Agent (site token)

HTTP: `POST /api/agent/v2/batch`, `GET /api/agent/v2/commands`,
`POST /api/agent/v2/commands/{id}/ack`, `GET /api/agent/v2/files`,
`POST /api/agent/v2/files/ack`, `POST /api/agent/v2/files/push`,
`GET /api/agent/v2/whoami`, `GET /api/agent/v2/backups/config`,
`POST /api/agent/v2/backups/upload?source=&command_id=&size=`.
WebSocket `GET /ws/site` (Authorization header) carries the same batch/command traffic.
The v1 API (`/api/agent/heartbeat`, `/config`, `/local-sync`, `/errors`, `/commands`,
`/statistics`, `/ai-usage`, `/chats`, `/backup-*`, `/backups/upload`) is still served.
