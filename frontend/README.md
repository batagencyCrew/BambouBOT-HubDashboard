# Bambou Hub v2 — dashboard

React 18 + TypeScript + Vite single-page console for the v2 hub API (`../docs/v2/API.md`).

```sh
npm install
npm run dev      # http://localhost:5173, proxies /api and /ws to http://127.0.0.1:8000
npm run build    # tsc -b && vite build → dist/ (served by the hub)
```

* Auth is the hub's HttpOnly session cookie (`POST /api/auth/login`); nothing sensitive is stored
  client-side. Any 401 returns to `/login`. Only the last selected site tab is kept in localStorage.
* Routes: `/login`, `/`, `/sites/:ref/:tab`, `/alerts`, `/users`, `/audit`.
* Actions the user lacks permission for are hidden or disabled (mirrors `can_site` using `/auth/me`).

Layout: `src/lib` (api client, auth, polling, formatting, types), `src/components` (UI kit, charts,
log viewer), `src/pages` (one folder/file per route; `pages/site/*Tab.tsx` for site tabs).
