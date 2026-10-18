# Per-site statistics telemetry

Statistics are automation-owned absolute snapshots, not inferred activity, increment events, or fabricated values. The hub does not know what a successful link/chat means. Whole-site aggregation and persistence/reset policy belong to the automation; one reporter per site prevents competing snapshots. Reposting a snapshot is idempotent (values replaced, never added).

- Agent-token only: POST `/api/agent/statistics`, JSON `{links_sent_successfully:integer,average_messages_per_chat:number|null}`; both fields required. Counter strictnonnegativeinteger <=9007199254740991; average finite nonnegative <=1000000000 ornull(no chats/unknown). Extra fields forbidden. Return Statistics.
- Admin-token only: GET `/api/sites/{id}/statistics` => Statistics.
- Statistics: `{site_id:string,links_sent_successfully:integer|null,average_messages_per_chat:number|null,updated_at:string|null}`. Beforeanyreport both metricsnull and updated_atnull. Explicitreported0 displays0, never confused withmissingdata. Server UTCtimestamp records receivedsnapshot. Persist SQLite and foreignkeyCASCADE site deletion. No historytime series required. Old agents withoutendpointcalls keepworking; dashboardpoll independent toavoid breaking sitebasicload ifstatsunavailable.
- No messages, chat transcripts, links/URLs, APIkeys, workeridentities or personaldata needed in payload. Onlynumericaggregates accepted. Backend validationerrors sanitized through existinghandler; TLS/authrequired as usual.

Dashboard: visible per-site **STATISTICS** section on Overview and a Statistics tab with the same two cards: **Links Sent Successfully**, **Average Messages Per Chat** (up to2decimalplaces). Show lastreportedtime; no-data and offlinehistoricalsnapshotnotice. Poll10s. No grandtotal average acrossworkers/sites. No localincrementAPI toavoidretriesdoublecounting.

Developer examples/helpers should send real accumulatedwhole-sitecounts orcomputedaverage, never publish defaultzeroautomatically. Document resetting/overwriting explicitly and advise derivingweightedavg as totalmessages/totalchats only if those are the caller'sdefinitions.
