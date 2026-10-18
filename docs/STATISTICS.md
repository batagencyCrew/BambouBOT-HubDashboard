# Site statistics

The dashboard displays **Links Sent Successfully** and **Average Messages Per Chat** in each site's Overview and Statistics tab. The hub stores the latest report; it does not infer what your automation considers a successful link, message, or chat.

Send a whole-site snapshot using that site's agent token:

```http
POST /api/agent/statistics
Authorization: Bearer <site-agent-token>
Content-Type: application/json

{"links_sent_successfully":274,"average_messages_per_chat":6.25}
```

These numbers are examples, not seeded dashboard data. Use your actual automation aggregates. Reporting the same snapshot again replaces the values rather than incrementing them, so HTTP retries do not double counts. A later lower value is allowed if your automation intentionally resets its reporting period. Keep accumulated totals/checkpoints in your automation if they must survive its restarts.

`links_sent_successfully` is a nonnegative integer up to `9,007,199,254,740,991`. `average_messages_per_chat` is a finite nonnegative number up to `1,000,000,000`, or `null` when unknown/no chats. Both fields are required. An explicit zero is displayed as zero; no report is displayed as missing data, not fabricated zero. The server records a UTC receipt timestamp.

Use a single aggregate reporter per site. Do not have every worker overwrite the site's snapshot independently. If your definition uses message/chat counts, calculate a weighted average from whole-site totals (`total messages / total chats`), not the average of worker averages. The hub intentionally does not choose your accounting rules or reporting period.

Administrator requests to `GET /api/sites/{id}/statistics` return:

```json
{
  "site_id": "site-uuid",
  "links_sent_successfully": 274,
  "average_messages_per_chat": 6.25,
  "updated_at": "2026-10-18T12:00:00Z"
}
```

Statistics persist across hub restarts. Offline sites retain their last report, labelled as a historical snapshot. No message bodies, chat transcripts, actual links, recipient identifiers, proxy credentials, or AI keys are needed or accepted in this endpoint.

The [Python, Node.js, and Go VPS starters](../templates/README.md) provide opt-in reporting helpers. Call them only when your automation has real aggregates to report; the placeholders never automatically publish zero or simulated business activity. Worker processes without a hub token should communicate their measurements to a trusted supervisor/aggregator rather than being given administrator credentials.

## Logs and navigation

Log tables use inline pages of 10 events, with filtering/search applied before pagination. Previous/Next changes only that table's React state and contents—there is no page navigation or full dashboard reload. Current site logs cover the latest 100 fetched events; pagination is not an export of the hub's entire retained history. The table viewport is bounded, with scroll for long rows, and pagination controls remain outside it.

Site tabs remain a single-line horizontal strip. On narrow screens, swipe/scroll horizontally or use keyboard arrow keys; the strip does not scroll vertically.
