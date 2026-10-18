# Hub Dashboard implementation contract

Backend: FastAPI + SQLite, lives in `backend/`. Frontend: React + TypeScript + Vite, lives in `frontend/`. Production backend serves frontend/dist when built. Default API port 8000. All timestamps UTC ISO 8601 strings. IDs UUID strings.

## Admin API
All endpoints under `/api`. Bearer access token required except POST `/auth/login` (`{password}` => `{access_token, token_type, expires_in}`). Dashboard password supplied via HUB_ADMIN_PASSWORD (required). Tokens expire after 8 hours.

- GET `/overview` => `{sites: Site[], recent_errors: Error[], summary: {sites, healthy, workers, running}}`
- GET `/sites` => Site[]
- POST `/sites` `{name, url, description?}` => `{site: Site, agent_token: string}` (token shown only at creation/regeneration)
- GET `/sites/{id}` => Site
- PATCH `/sites/{id}` `{name?, url?, description?}` => Site
- DELETE `/sites/{id}` => 204
- GET `/sites/{id}/workers` => Worker[]
- GET `/sites/{id}/errors?limit=100` => Error[]
- GET `/sites/{id}/config` => Config
- PUT `/sites/{id}/config` `{ai_api_key?: string, captcha_api_key?: string, number_of_workers: number, ai_preset_id: string}` => Config. Omitted keys preserve secrets; explicit empty clears.
- POST `/sites/{id}/presets` `{ai_api_key?: string}` => `{presets:[{id:string,name:string,archived:boolean}]}`. Admin only. Uses the site's encrypted AI key when omitted, or a transient entered key without saving it. Calls the fixed HTTPS BambouBotAI presets API server-side using bearer authentication. Provider errors are sanitized; no stored key is exposed to the browser.
- GET `/sites/{id}/proxies` => Proxy[] (password omitted; has_password boolean)
- POST `/sites/{id}/proxies` `{url: string, username?: string, password?: string}` => Proxy (http/https/socks5 URLs without credentials only)
- DELETE `/sites/{id}/proxies/{proxy_id}` => 204
- POST `/sites/{id}/commands` `{action: 'start'|'stop'|'restart'}` => Command
- GET `/sites/{id}/commands` => Command[] (latest 20)
- POST `/sites/{id}/agent-token` => `{agent_token}`
- GET `/health` public => `{status: 'ok'}`

Site: `{id,name,url,description,status:'healthy'|'degraded'|'offline',desired_state:'running'|'stopped',last_seen:string|null,created_at,worker_count:number,healthy_workers:number}`. Offline if no heartbeat in 60 seconds. Degraded if heartbeat reports degraded or unhealthy workers.
Worker: `{id,name,status:'running'|'idle'|'error'|'stopped',cpu_percent:number,memory_mb:number,tasks_completed:number,last_seen:string}`
Error: `{id,site_id,site_name,worker_id:string|null,level:'info'|'warning'|'error',message,timestamp}`
Config: `{number_of_workers:number,ai_preset_id:string,has_ai_api_key:boolean,has_captcha_api_key:boolean,updated_at}`
Proxy: `{id,url,username,has_password,created_at}`
Command: `{id,action,status:'pending'|'delivered'|'completed'|'failed',created_at,completed_at:string|null,message:string|null}`

## Agent API
Bearer site-scoped agent token; no dashboard access. All endpoints `/api/agent`:
- POST `/heartbeat` `{status:'healthy'|'degraded',workers: [{id,name,status,cpu_percent?,memory_mb?,tasks_completed?}]}` => `{site_id,desired_state,server_time}`. Replaces worker snapshot atomically.
- GET `/config` => `{number_of_workers,ai_preset_id,ai_api_key,captcha_api_key,proxies:[{id,url,username,password}]}` (secrets intentionally available only to its site agent)
- POST `/errors` `{worker_id?,level:'info'|'warning'|'error',message}` => `{id}`
- GET `/commands` => Command[] (pending and delivered, for at-least-once delivery; agent must deduplicate by id and acknowledge)
- POST `/commands/{id}/ack` `{status:'completed'|'failed',message?}` => Command

Agent poll interval 5s; heartbeat 15s; refresh config 30s. Commands are explicit local lifecycle hooks, never arbitrary shell received remotely. HTTPS required publicly. Do not log secret material. Keys encrypted at rest with persistent Fernet key in HUB_ENCRYPTION_KEY. SQLite data in HUB_DATA_DIR (default ./data).
