export const STATUS_COLORS: Record<string, string> = {
  healthy: "#22c55e",
  running: "#22c55e",
  degraded: "#f59e0b",
  offline: "#ef4444",
  error: "#ef4444",
  idle: "#38bdf8",
  starting: "#38bdf8",
  stopped: "#94a3b8",
  unknown: "#94a3b8",
};

export const colorFor = (status: string) => STATUS_COLORS[status] ?? STATUS_COLORS.unknown;
