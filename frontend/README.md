# Bambou Automation Hub frontend

React, TypeScript, and Vite dashboard using the API in `../CONTRACT.md`. No demo data or client-side secret storage.

```sh
npm install
npm run dev
```

Vite proxies `/api` to `http://localhost:8000`. Start the backend separately, with `HUB_ADMIN_PASSWORD` configured. Sign in with that password. The bearer token is kept in `sessionStorage` for this browser tab; unauthorized responses return to sign-in.

```sh
npm run typecheck
npm run build
npm run preview
```

Production files are output to `dist/`, which the backend serves. `preview` serves only static frontend files; use the backend or the development server for API access.

The dashboard polls every 10 seconds while visible and refreshes when the tab becomes visible again. Worker lifecycle commands are queued, not optimistically marked as running. Configuration secrets are write-only: blank fields omit secret keys to preserve them, and explicit **Clear key** controls submit an empty string. Agent tokens are displayed only immediately after creation or rotation, never persisted by the frontend.

Site and event filters are client-side filters over the server response. Site logs use the latest 100 events; command history uses the latest 20 commands. All timestamps are rendered in the browser’s local timezone. Fonts have system fallbacks if Google Fonts is unavailable.
