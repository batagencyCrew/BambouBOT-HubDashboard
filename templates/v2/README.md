# Script starters (hub v2)

Two equivalent, runnable starters for a new automation script:

| Folder | Language | Entry point |
| --- | --- | --- |
| `python/` | Python 3.9+ (standard library only) | `main.py` |
| `node/` | Node.js 18+ (no dependencies) | `main.js` |

Both run out of the box with a **simulated** task, so you can watch everything
appear in the dashboard before writing any real code. The simulated task produces:
* 2 workers
* logs
* `tasks_completed`, `links_sent` and `messages` metrics
* captcha and AI costs
* proxy health
* a `refresh_sessions` custom command

Both starters were tested this way against the live hub.

## What to replace

Search the file for `TODO`. In order:

1. **Settings** (`Settings.reload` / `settings.reload`): read the values your script needs
   from `config.json`, `.env` and `proxies.txt`. These files are editable from the hub.
   Your script is told when they change (`on_config_change` / `onConfigChange`), and
   the settings reload automatically.
2. **Prices** (`set_price` / `setPrice`): your providers and unit prices. Or pass an
   exact amount each time: `hub.add_cost(0.0021, provider="openai", category="ai")`.
3. **`open_session` / `openSession`**: create one worker's browser, page or HTTP session.
4. **`do_task` / `doTask`**: one unit of work. Delete the simulation block, then:
   * call `hub.add_cost(...)` wherever money is spent
   * call `hub.proxy(label, state, url=proxy)` when you learn whether a proxy worked
   * raise `TaskFailed` for an expected failure; the worker keeps going, and after 5
     failures in a row it raises a hub issue that's forwarded to Discord/Telegram
5. **`close_session` / `closeSession`**.
6. **Commands**: implement `refresh_sessions` or delete it, and add your own with
   `hub.on_command(...)` / `hub.onCommand(...)`. They appear in the dashboard and as
   `/hub` bot commands.
7. **Balances** (optional): report provider balances with `hub.balance(...)` to get
   low-balance alerts.

Everything else stays as-is:
* the worker loop
* pause/resume
* live worker count ("Set workers" in the hub)
* graceful stop
* crash reporting

## Set up a new script

```bash
cp -r templates/v2/python /opt/scripts/mysite        # or templates/v2/node
cd /opt/scripts/mysite
cp .env.example .env && chmod 600 .env
mkdir -p vendor && cp -r /opt/bambou-agent/sdk/python/bambouhub vendor/   # Node: cp -r .../sdk/node vendor/bambouhub
```

Then run it under `bambou-agent` with `--file config.json --file .env --file proxies.txt`;
see [docs/v2/INTEGRATION.md](../../docs/v2/INTEGRATION.md).

## Moving an existing script onto the hub

You don't have to rewrite it into this template. The minimum (from INTEGRATION.md):

1. Read keys, counts and proxies from `config.json` / `.env` / `proxies.txt`.
2. Add `from bambouhub import hub; hub.install_logging()`.
3. Wrap each worker's loop in `with hub.worker(name) as w:`.
4. Add `hub.add_cost(...)` next to paid calls and `hub.proxy(...)` where proxy results are known.
5. Run it under `bambou-agent`.

Use the template as a reference for the details.
