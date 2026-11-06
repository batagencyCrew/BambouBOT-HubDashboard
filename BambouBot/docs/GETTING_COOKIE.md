# Getting your GetMySocial session cookie

The bot authenticates with your **logged-in browser session** instead of a paid API key.
The cookie is as sensitive as your password — keep it in an env var / secret manager, never in git.

## Steps (Chrome / Edge / Brave / Firefox)

1. Log in at <https://getmysocial.com/login> and **tick "Remember me for 30 days"**.
2. Open DevTools (**F12**) → **Network** tab.
3. Reload the dashboard page (`F5`) so requests appear.
4. Click any request to `getmysocial.com` (e.g. `links/board`).
5. In **Headers → Request Headers**, find `Cookie:`.
6. Right-click its value → **Copy value**.

You'll get a single long line like:

```
gms_session=...; cf_clearance=...; __cf_bm=...
```

7. **Store it in BambouBot's `.env`** (gitignored, chmod 600):

```bash
cd BOTS/BambouBot
chmod 600 .env
nano .env                   # paste the value after GMS_COOKIE=
```

Then restart the bot. If the value contains quotes, wrap it in double quotes; the loader
strips one matching pair. Real environment variables always beat `.env`.

## Why not `copy(document.cookie)`?

The session cookie is **HttpOnly**, so it does not appear in `document.cookie` /
the Console. The Network-tab method above is the reliable way. (Application →
Cookies also works — copy each row's value manually.)

## Notes

- Include **all** cookies from that header (`cf_clearance`, `__cf_bm`, etc.) — the
  whole line, exactly as the browser sent it.
- If the bot runs from a different machine/IP than your browser, that's fine for the
  session; `cf_clearance` is IP-bound and may simply be ignored. If Cloudflare ever
  starts challenging requests, re-grab the cookie **from the machine that runs the bot**
  (open the dashboard there once, or run the bot with a headful browser profile).
- **Lifetime:** up to ~30 days with "Remember me". When it expires the client throws
  `SessionExpiredError` (the server answers with a 302 instead of JSON). Fix = repeat
  steps 1–6 and update `GMS_COOKIE`.
- **Rotation:** when done testing, log out of all sessions (Dashboard → Settings →
  Security → Active sessions → sign out) — that invalidates the copied cookie instantly.
