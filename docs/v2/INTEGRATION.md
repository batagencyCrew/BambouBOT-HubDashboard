# Connecting a script to the hub

Each site has **one script on one VPS**. On that VPS you run `bambou-agent` next to the
script, and inside the script you use the `bambouhub` SDK.

```
hub  ◄── WSS/HTTPS ──  bambou-agent  ◄── unix socket ──  your script + bambouhub SDK
```

* The **agent** owns the hub token, starts/stops/restarts the script, restarts it after
  crashes, syncs `config.json` / `.env` / `proxies.txt`, reports VPS CPU/RAM/disk, backs
  up the code, and keeps data on disk while the hub is unreachable.
* The **SDK** gives the script workers, logs, metrics, costs, balances, proxy health,
  issues and commands. It never sees the hub token.

## 1. Create the site and get a token

Dashboard → **Sites → Add site**. Copy the agent token (shown once). Rotate it later from
the site's *Settings* tab.

## 2. Install the agent on the VPS

```bash
sudo mkdir -p /opt/bambou-agent && cd /opt/bambou-agent
# copy agent2/ and sdk/ from this repo, then:
python3 -m venv .venv && .venv/bin/pip install -r agent2/requirements.txt
```

Create `/etc/bambou-agent/<site>.env` (mode 600):

```dotenv
HUB_URL=https://hub.example.com
HUB_AGENT_TOKEN=hst_...
```

Run it (see `deploy/bambou-agent@.service` for systemd):

```bash
PYTHONPATH=/opt/bambou-agent/agent2 .venv/bin/python -m bambou_agent \
  --script-dir /opt/scripts/demo \
  --command "/opt/scripts/demo/.venv/bin/python demo_bot.py" \
  --file config.json --file .env --file proxies.txt
```

| Option | Meaning |
| --- | --- |
| `--script-dir` | Script root. Managed files and backups are relative to it. |
| `--command` | How to start the script. Omit it if something else starts the script; the agent then only relays telemetry, files and backups. |
| `--file PATH[:FORMAT]` | File to manage (repeatable). Format is guessed: `.env` → env, `*.json` → json, `*prox*.txt` → proxies, `*prox*.json` → proxy-json; else text. |
| `--no-crash-restart` | Do not restart the script automatically after it crashes. |
| `--no-backup` | Disable backups on this VPS. |
| `--backup-exclude GLOB` | Extra excludes (hub defaults: `.git node_modules __pycache__ .venv venv`). |
| `--env KEY=VALUE` | Extra environment variables for the script. |

The script is started with `HUB_AGENT_SOCKET` set; the SDK uses it automatically.

## 3. Add the SDK to the script

### Python

```python
import sys; sys.path.insert(0, "/opt/bambou-agent/sdk/python")   # or pip install -e sdk/python
from bambouhub import hub

hub.install_logging()                 # every logging.* call now reaches the hub
```

Workers — any model works; declare each unit of parallel work:

```python
def run(account):
    with hub.worker(f"worker-{account.id}") as w:      # running on enter, stopped/error on exit
        while not hub.stopping.is_set():
            hub.wait_if_paused()                        # honours Pause/Resume
            w.idle("waiting for partner")               # shows idle + reason; alerts after 15 min
            ...
            w.running()
            w.task_done()
```

* **Threads / ThreadPoolExecutor**: use `with hub.worker(...)` inside the thread function.
* **asyncio**: same — the worker is bound to the task's context.
* **Separate processes**: each process imports the SDK; the agent merges them.
* **Browsers (Selenium/AdsPower/Playwright)**: one worker per browser/profile.

Logs, attributed to the worker automatically when inside `with hub.worker(...)`:

```python
log.info("connected")            # stdlib logging (after install_logging)
w.log.warning("slow proxy")      # explicit
hub.error("login failed", exc_info=True, account="a1")   # extra fields become context
```

**Costs** — call `add_cost` wherever money is spent. The SDK sums entries locally and
sends them every 2 s; the hub keeps them forever and totals per day/provider/site.

```python
hub.set_price("capsolver", 0.0008, unit="solve")   # once, at startup
hub.add_cost(provider="capsolver", category="captcha")         # uses the price
hub.add_cost(0.0021, provider="openai", category="ai", quantity=1, unit="request")
hub.addCost(cost_of_req, provider="smsactivate", category="sms")  # alias

with hub.cost("2captcha", "captcha") as c:   # records on exit, c.cancel() to skip
    c.amount = solve_and_get_price()

hub.cost_summary()   # running totals since start: {"USD": {"capsolver": 1.23}}
```

**Balances** (alerts when at/below `low`):

```python
hub.balance("capsolver", capsolver.get_balance(), low=5)
```

**Proxy health** — report results; the hub never receives credentials (the URL is hashed):

```python
hub.proxy("proxy-3", "ok", url=proxy_url)
hub.proxy("proxy-3", "blocked", url=proxy_url, detail="HTTP 403 from site")
# states: ok | slow | blocked | auth | timeout
```

**Metrics** — anything you want to chart:

```python
hub.count("links_sent")                 # summed
hub.gauge("queue_size", len(queue))     # averaged
hub.timing("chat_seconds", 41.7)
```

**Issues** — things a human must look at; forwarded to Discord/Telegram:

```python
hub.issue("Login loop", "worker-2 re-logged 5 times in 10 min", severity="critical")
```

**Commands** — built-ins set flags you read; custom ones appear as buttons/bot commands:

```python
hub.paused.is_set()          # Pause/Resume
hub.desired_workers          # Set workers (None until changed)
hub.stopping.is_set()        # Stop requested (the agent also sends SIGTERM)

@hub.on_command("refresh_cookies", description="Log in again on every worker")
def refresh_cookies():
    ...
    return "refreshed 4 sessions"      # shown in the dashboard

@hub.on_config_change
def reload(path):                       # after the hub rewrote a managed file
    global config; config = json.load(open("config.json"))
```

### Node.js

```js
const { hub } = require('/opt/bambou-agent/sdk/node');
hub.captureConsole();                          // console.warn/error → hub
const w = hub.worker('worker-1');
w.running(); w.idle('no partner'); w.log.info('connected'); w.taskDone();
hub.setPrice('capsolver', 0.0008, { unit: 'solve' });
hub.addCost(null, { provider: 'capsolver', category: 'captcha' });
hub.addCost(0.0021, { provider: 'openai', category: 'ai' });
hub.balance('capsolver', 3.1, { low: 5 });
hub.proxy('proxy-1', 'blocked', { url: proxyUrl, detail: '403' });
hub.issue('Login loop', 'worker-2 relogged 5 times', { severity: 'warning' });
hub.onCommand('refresh_cookies', async () => 'done', { description: 'Re-login' });
hub.onConfigChange((path) => reload(path));
hub.on('set_workers', (count) => scale(count));
await hub.waitIfPaused();
```

`worker_threads`: require the SDK inside the thread too, and call
`hub.attachThread(worker)` in the main thread so its data and commands are relayed.

### Without the agent (not recommended)

Set `HUB_URL` and `HUB_AGENT_TOKEN` for the script itself: the SDK then posts directly
to the hub and polls commands. Start/restart, crash restarts, file sync and backups
need the agent.

## 4. Config files

Files passed with `--file` are uploaded on first run, then shown in the site's **Files**
tab. Editing there (or with the bot) writes the file on the VPS within seconds and tells
the script via `on_config_change`. Editing the file by hand on the VPS is detected and
uploaded. See `ARCHITECTURE.md → Config files` for conflict rules.

Secrets in `.env`/JSON (keys containing *key, token, secret, password, cookie, session,
auth…*) and proxy passwords are masked unless the viewer has `secrets:reveal`.

## Existing scripts: minimal change

1. Move hard-coded values (API keys, proxy, counts) into `config.json` / `.env` /
   `proxies.txt` and read them at startup.
2. Add `from bambouhub import hub; hub.install_logging()`.
3. Wrap each worker's loop in `with hub.worker(name) as w:`.
4. Add `hub.add_cost(...)` next to each paid API call and `hub.proxy(...)` where proxy
   results are known.
5. Run the script under `bambou-agent`.

Steps 2–3 alone already give per-worker logs and health in the dashboard.
