# Backup implementation contract

Flow: trusted site script/agent uploads opaque bytes -> durable hub staging -> rclone copies to one or more configured cloud destinations. No extraction or execution. All endpoints use existing admin/agent bearer separation. The hub's existing public upload body-limit middleware MUST bypass ONLY the exact `/api/agent/backups/upload` path; the upload handler enforces streaming quotas itself without buffering the file.

## Administrator API

All paths below prefixed `/api`. Never return cloud credentials, raw rclone output, or internal filesystem paths.

- GET `/backup-destinations` => Destination[]
- GET `/backup-remotes` => `{available:boolean,remotes:string[],message:string|null}`. Remotes are configured by the operator with rclone, not by submitting credentials via this API. Safe subprocess listremotes with timeout.
- POST `/backup-destinations` `{name,remote,folder?,enabled?:boolean}` => Destination (201)
- PATCH `/backup-destinations/{id}` `{name?,remote?,folder?,enabled?}` => Destination. Queued transfer snapshots remain unchanged by edits.
- DELETE `/backup-destinations/{id}` =>204. Refuse409 while referenced by site config or nonterminal transfers; history retained without cascading deletion.
- GET `/backup-storage` => `{used_bytes,max_bytes,max_upload_bytes,retention_days,cached_files,max_cached_files}`
- GET `/sites/{id}/backup-config` => BackupConfig
- PUT `/sites/{id}/backup-config` `{enabled:boolean,interval_minutes:integer,destination_ids:string[]}` => BackupConfig. Interval15..43200, default1440; destination_ids must exist and be enabled. When enabled, require >=1 destination; allow disabled config with no destinations.
- POST `/sites/{id}/backups/request` `{}` => BackupRequest (201). Requires >=1 selected enabled destination even if periodic schedule is disabled. Snapshots targets. Bounded pending queue20/site.
- GET `/sites/{id}/backups` => `{backups:Backup[],requests:BackupRequest[]}` latest50 each.
- GET `/sites/{id}/backups/{backup_id}/download` => authenticated FileResponse ONLY if local cached complete upload exists (not partial), content-disposition attachment and octet-stream, nosniff.
- POST `/sites/{id}/backups/{backup_id}/retry` `{}` => Backup. Retry failed transfers only if cached artifact exists. Never reroute completed transfers. A destination disabled since creation must not be retried until enabled again. Targets are snapshots.
- DELETE `/sites/{id}/backups/{backup_id}/local` =>204. Evict local cache only; refuse409 while uploading/queued/transferring or retrying; cloud copies/history retained.

Destination: `{id,name,remote,folder,enabled,created_at}`. remote is a configured rclone remote NAME without colon, folder is a relative POSIX folder. Validate remote/folder against controls, traversal, schemes, absolute paths, flags. Use argv subprocess without shell. A local-type configured rclone remote is acceptable for tests; remote names only never unrestricted local paths.
BackupConfig: `{enabled,interval_minutes,destination_ids,agent_configured:boolean,agent_last_seen:string|null,next_backup_at:string|null}`. Agent capability values are telemetry, not proof an archive exists.
BackupRequest: `{id,site_id,status:'pending'|'delivered'|'uploaded'|'failed',created_at,completed_at:string|null,message:string|null,backup_id:string|null}`.
Backup: `{id,site_id,filename,size_bytes,sha256:string|null,status:'uploading'|'queued'|'transferring'|'completed'|'partial'|'failed',source:'scheduled'|'on_demand'|'direct',created_at,completed_at:string|null,local_available:boolean,error:string|null,transfers:Transfer[]}`.
Transfer: `{id,destination_id,destination_name,status:'queued'|'transferring'|'completed'|'failed',attempts:number,error:string|null,completed_at:string|null,remote_path:string}`. remote_path is a safe cloud path, not credentials. Backup `completed` only if ALL cloud transfers complete; partial if some succeeded and others permanently failed; failed if none succeeded and all terminal; retrying returns queued/transferring.

## Site agent API

All prefixed `/api/agent`, site token only:
- GET `/backup-config` => BackupConfig (same safe shape)
- POST `/backup-status` `{configured:boolean,next_backup_at?:string|null}` => `{status:'ok'}`. Never accept a source path or shell command from the dashboard; source directory is local configuration.
- GET `/backup-requests` => BackupRequest[] pending and delivered, at-least-once; mark pending delivered.
- POST `/backup-requests/{id}/ack` `{status:'failed',message?:string}` => BackupRequest. Upload success marks uploaded automatically. Bounded sanitized error messages.
- POST `/backups/upload?filename=code.tar.gz&request_id=<optional UUID>&source=scheduled|on_demand|direct` with raw request bytes and `Content-Type: application/octet-stream` => Backup (201). Any binary format, including empty files; no extension restrictions. Default source direct. request_id must belong to this site, be pending/delivered, and snapshots its destinations; require request_id for on_demand. Direct/scheduled uploads use current selected enabled targets. Reject if no valid destination.

Upload filename is a safe basename (no slash/backslash/control/traversal), <=200 chars. Store under UUID-generated paths with owner-only permissions, stream SHA256, enforce configurable per-file and total staging quotas during streaming including chunked requests, clean partial files and reservations on disconnect/error. Reject too-large files413 and storage exhaustion507. Content-Length when present validated but never trusted as the only limit. Do not delete completed cloud artifacts automatically.

## Persistence and transfers

Backend implementation isolated in `backend/hub/backups.py` with `install_backups(app, store, admin, agent, data_dir)` invoked near end of create_app before SPA route. Reuse store.transaction short transactions only; don't hold DB locks during stream reads or rclone calls. Add tables idempotently (existing production database must survive). Site deletion MUST refuse409 while backup uploads/queued transfers exist, and clean cached artifacts/history safely otherwise, or refuse deletion while ANY backup history exists with an actionable message. Never leave orphan site references.

Environment: HUB_RCLONE_CONFIG (default `<data_dir>/rclone.conf`), HUB_RCLONE_BINARY (default rclone), HUB_BACKUP_MAX_UPLOAD_BYTES (default1073741824), HUB_BACKUP_MAX_STORAGE_BYTES (default10737418240), HUB_BACKUP_RETENTION_DAYS (default7), HUB_BACKUP_TRANSFER_TIMEOUT_SECONDS (default3600), HUB_BACKUP_WORKER_ENABLED (default true; false for isolated tests). Values strictly validated positive/bounded.

One managed background worker per app, with deterministic shutdown (terminate active subprocess). Durable queue and startup recovery: interrupted transfers requeued; partial uploads failed and cleaned. Only run startup recovery when worker starts (not per upload). rclone copyto argv fixed flags and destination `<remote>:<folder>/<site_id>/<backup_id>/<filename>`, no shell, no user-controlled flags. Capture/discard output; expose sanitized errors only. At most3 automatic attempts with bounded exponential backoff, then manual retry. Cloud destinations edited later do not change in-flight snapshot remote/folder/name. Disabled/deleted destination must not dispatch new transfers; visible failure until reenabled/retried. Completed cached files cleaned after retention; failed files retained for retry/manual eviction. Quota accounting includes active reservations. Mark success only after rclone process returns0; SHA256 is hub file integrity, not a promise of remote end-to-end verification.

Local cache deletion and download must be coordinated with worker/upload so an active file cannot disappear mid-transfer. File persistence and DB transitions must be crash-safe enough that restart detects/reports missing files rather than claiming success. Configured cloud credentials are operator-managed rclone config (may need write permission for OAuth token refresh); do not commit it.

Hard count limits: cached/uploading artifacts2,000/site and10,000global; combined backup/request metadata10,000/site and100,000global; activebackups100/site and1,000global; uploads5/site and20global; destinations100global and20targets/site. Metadata capacity is reclaimed only from oldest eligible terminal/uncached history without active or pending request references; otherwise409. No cloud deletion. Upload persistence uses8 bounded background threads; final cloud outcomes have private durable journals for DB-failure/restart replay.

## Frontend placement

New `Backups` site tab after Proxies. Component `Backups.tsx` owns own 10s polling, don't alter SiteData/load contract. Include per-site periodic schedule toggle/interval/destinations, on-demand `Request backup` control, source-not-configured/offline warnings, request states separately from upload/cloud completion, history with transfers/errors/download/retry/cache eviction confirmations, staging storage usage, and a clearly labelled hub-wide destination management panel shared by all sites. Remotes discovered server-side; operator setup hints for rclone/Google Drive. No cloud credentials or arbitrary commands accepted in browser. Preserve unsaved schedule form during polling.
