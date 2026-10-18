export interface Site {
  id: string;
  name: string;
  url: string;
  description: string;
  status: "healthy" | "degraded" | "offline";
  desired_state: "running" | "stopped";
  last_seen: string | null;
  created_at: string;
  worker_count: number;
  healthy_workers: number;
}
export interface Worker {
  id: string;
  name: string;
  status: "running" | "idle" | "error" | "stopped";
  cpu_percent: number;
  memory_mb: number;
  tasks_completed: number;
  last_seen: string;
}
export interface HubError {
  id: string;
  site_id: string;
  site_name: string;
  worker_id: string | null;
  level: "info" | "warning" | "error";
  message: string;
  timestamp: string;
}
export interface Config {
  number_of_workers: number;
  ai_preset_id: string;
  has_ai_api_key: boolean;
  has_captcha_api_key: boolean;
  updated_at: string;
}
export interface AIPreset {
  id: string;
  name: string;
  archived: boolean;
}
export interface PresetsResponse {
  presets: AIPreset[];
}
export interface Proxy {
  id: string;
  url: string;
  username: string | null;
  has_password: boolean;
  created_at: string;
}
export type Action = "start" | "stop" | "restart";
export interface Command {
  id: string;
  action: Action;
  status: "pending" | "delivered" | "completed" | "failed";
  created_at: string;
  completed_at: string | null;
  message: string | null;
}
export interface Overview {
  sites: Site[];
  recent_errors: HubError[];
  summary: { sites: number; healthy: number; workers: number; running: number };
}
export interface SiteData {
  site: Site;
  workers: Worker[];
  errors: HubError[];
  config: Config;
  proxies: Proxy[];
  commands: Command[];
}
