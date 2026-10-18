import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";

export function usePolling<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const running = useRef(false);
  const active = useRef(false);
  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setRefreshing(true);
    try {
      const result = await load();
      if (active.current) {
        setData(result);
        setError("");
        setUpdatedAt(new Date());
      }
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      running.current = false;
      if (active.current) setRefreshing(false);
    }
  }, [load]);
  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    const onFocus = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      active.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);
  return { data, error, refreshing, updatedAt, refresh };
}
