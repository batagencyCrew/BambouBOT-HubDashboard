export type Health = "healthy" | "degraded" | "offline";
export type WorkerStatus = "running" | "idle" | "error" | "stopped" | "starting" | "unknown";

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: string;
  permissions: string[];
  extra_permissions: string[];
  site_scope: string[] | null;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface Catalog {
  permissions: Record<string, string>;
  roles: Record<string, string[]>;
}

export interface HostInfo {
  cpu_percent?: number;
  cpu_count?: number;
  load?: number[];
  memory_percent?: number;
  memory_total_mb?: number;
  disk_percent?: number;
  disk_free_gb?: number;
  uptime?: number;
  [k: string]: unknown;
}

export interface ProcessInfo {
  pid?: number | null;
  running?: boolean;
  restarts?: number;
  crash_loop?: boolean;
  last_exit?: unknown;
  uptime?: number;
  cpu_percent?: number;
  memory_mb?: number;
  [k: string]: unknown;
}

export interface Capabilities {
  commands: unknown[];
  files: unknown[];
  sdk: string;
}

export interface Site {
  id: string;
  slug: string;
  name: string;
  url: string;
  description: string;
  desired_state: string;
  crash_restart: boolean;
  created_at: string;
  health: Health;
  online: boolean;
  last_seen_at: string | null;
  workers: Record<WorkerStatus, number>;
  worker_total: number;
  host: HostInfo;
  process: ProcessInfo;
  agent_version: string;
  capabilities?: Capabilities;
}

export interface Alert {
  id: string;
  site_id: string | null;
  site_name: string;
  worker_id: string | null;
  severity: "info" | "warning" | "critical" | string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  status: "open" | "acknowledged" | "muted" | "resolved" | string;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
  muted_until: string | null;
  dedup_key: string;
  ack_by?: string | null;
}

export interface Overview {
  totals: {
    sites: number;
    online: number;
    healthy: number;
    degraded: number;
    offline: number;
    workers_running: number;
    workers_idle: number;
    workers_error: number;
    errors_24h: number;
    cost_today: Record<string, number>;
  };
  sites: Site[];
  alerts: Alert[];
}

export interface Command {
  id: string;
  site_id: string;
  action: string;
  args: Record<string, unknown>;
  status: string;
  created_at: string;
  delivered_at: string | null;
  completed_at: string | null;
  result: string | null;
  source: string | null;
  requested_by?: string | null;
  agent_online?: boolean;
}

export interface Worker {
  id: string;
  site_id: string;
  name: string;
  status: WorkerStatus;
  detail: Record<string, unknown>;
  pid: number | null;
  cpu_percent: number;
  memory_mb: number;
  tasks_completed: number;
  last_seen_at: string;
  started_at: string | null;
}

export interface WorkerSample {
  bucket: string;
  cpu: number | null;
  memory: number | null;
  tasks: number | null;
  status: string | null;
}

export interface SiteStats {
  site_id: string;
  since: string;
  logs: { warnings: number; errors: number; total: number };
  metrics: { name: string; kind: string; value: number; peak: number; samples: number }[];
  costs: { currency: string; total: number }[];
  tasks_completed: number;
}

export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";

export interface LogEntry {
  id: number;
  site_id: string;
  site_name: string;
  worker_id: string | null;
  worker_name: string | null;
  ts: string;
  level: LogLevel | string;
  source: string | null;
  message: string;
  context: unknown;
  exception: string | null;
}

export interface Page<T> {
  items: T[];
  next_before_id: number | null;
}

export interface MetricInfo {
  name: string;
  kind: string;
  samples: number;
  last_ts: string;
}

export interface MetricSeries {
  name: string;
  kind: string | null;
  bucket: string;
  points: { ts: string; value: number; samples: number }[];
}

export type CostGroup = "day" | "provider" | "category" | "site" | "worker";

export interface CostReport {
  group_by: CostGroup;
  rows: { key: string; currency: string; total: number; events: number; quantity: number | null }[];
  totals: Record<string, number>;
}

export interface CostEvent {
  ts: string;
  category: string;
  provider: string;
  amount: number;
  currency: string;
  quantity: number | null;
  unit: string | null;
  worker_id: string | null;
  meta: unknown;
}

export interface Balance {
  site_id: string;
  site_name: string;
  provider: string;
  label: string | null;
  currency: string;
  balance: number;
  low_threshold: number | null;
  low: boolean;
  reported_at: string;
}

export interface ProxyHealth {
  proxy_key: string;
  label: string | null;
  observations: number;
  ok: number;
  slow: number;
  blocked: number;
  auth: number;
  timeout: number;
  last_ts: string;
  last_state: string;
  last_detail: string | null;
  success_rate: number | null;
  failures: number;
  health: "healthy" | "degraded" | "failing";
}

export type FileFormat = "json" | "env" | "proxies" | "proxy-json" | "text";

export interface ManagedFile {
  path: string;
  format: FileFormat;
  revision: number;
  applied_revision: number;
  applied_at: string | null;
  apply_error: string | null;
  updated_at: string;
  sha256: string;
  in_sync: boolean;
}

export interface ProxyEntry {
  line: number;
  key: string;
  url: string;
  scheme: string;
  host: string;
  port: number;
  username: string | null;
  has_password: boolean;
}

export interface EnvItem {
  key: string;
  value: string;
  secret: boolean;
  line: number;
}

export interface FileView extends ManagedFile {
  secret_keys: string[];
  content: string;
  parsed: unknown;
  parse_error: string | null;
  revealed: boolean;
}

export interface FileHistoryEntry {
  id: number;
  revision: number;
  action: string;
  changed_at: string;
  summary: Record<string, unknown> | null;
  sha256: string;
  username: string | null;
}

export interface Destination {
  id: string;
  name: string;
  remote: string;
  folder: string;
  enabled: boolean;
}

export interface BackupConfig {
  site_id: string;
  enabled?: boolean;
  interval_minutes?: number;
  destination_ids: string[];
  keep_count?: number;
  exclude_files?: string[];
  agent: Record<string, unknown>;
}

export interface Transfer {
  destination: string;
  status: string;
  attempts: number;
  error: string | null;
  remote_path: string;
  completed_at: string | null;
}

export interface Backup {
  id: string;
  site_id: string;
  source: string;
  status: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  completed_at: string | null;
  note: string;
  local_available: boolean;
  transfers: Transfer[];
}

export interface Channel {
  platform: "discord" | "telegram";
  chat_id: string;
}

export interface AlertRule {
  id: string;
  site_id: string | null;
  name: string;
  kind: string;
  params: Record<string, unknown>;
  severity: "info" | "warning" | "critical";
  enabled: boolean;
  channels: Channel[];
  cooldown_seconds: number;
}

export interface SiteToken {
  id: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface BotLink {
  platform: string;
  platform_user: string;
  created_at: string;
  username?: string;
}

export interface ServiceToken {
  id: string;
  kind: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface AuditEntry {
  id: number;
  ts: string;
  user_id: string | null;
  actor: string;
  source: string;
  action: string;
  site_id: string | null;
  site_name: string | null;
  target: string | null;
  detail: unknown;
  ip: string;
}
