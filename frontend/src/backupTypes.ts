export interface Destination {
  id: string;
  name: string;
  remote: string;
  folder: string;
  enabled: boolean;
  created_at: string;
}
export interface BackupRemotes {
  available: boolean;
  remotes: string[];
  message: string | null;
}
export interface BackupStorage {
  used_bytes: number;
  max_bytes: number;
  max_upload_bytes: number;
  retention_days: number;
  cached_files?: number;
  max_cached_files?: number;
}
export interface BackupConfig {
  enabled: boolean;
  interval_minutes: number;
  destination_ids: string[];
  agent_configured: boolean;
  agent_last_seen: string | null;
  next_backup_at: string | null;
}
export interface BackupRequest {
  id: string;
  site_id: string;
  status: "pending" | "delivered" | "uploaded" | "failed";
  created_at: string;
  completed_at: string | null;
  message: string | null;
  backup_id: string | null;
}
export interface Transfer {
  id: string;
  destination_id: string;
  destination_name: string;
  status: "queued" | "transferring" | "completed" | "failed";
  attempts: number;
  error: string | null;
  completed_at: string | null;
  remote_path: string;
}
export interface Backup {
  id: string;
  site_id: string;
  filename: string;
  size_bytes: number;
  sha256: string | null;
  status: "uploading" | "queued" | "transferring" | "completed" | "partial" | "failed";
  source: "scheduled" | "on_demand" | "direct";
  created_at: string;
  completed_at: string | null;
  local_available: boolean;
  error: string | null;
  transfers: Transfer[];
}
export interface BackupHistory {
  backups: Backup[];
  requests: BackupRequest[];
}
