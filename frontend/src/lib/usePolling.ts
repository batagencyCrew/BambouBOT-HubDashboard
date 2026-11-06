import { useCallback, useEffect, useRef, useState } from "react";

interface PollingState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Polls an async loader on an interval without overlapping requests.
 * The in-flight request is aborted when the component unmounts or the deps change.
 */
export function usePolling<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  intervalMs: number | null,
  deps: unknown[] = [],
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const run = async () => {
      controller = new AbortController();
      try {
        const result = await loaderRef.current(controller.signal);
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (intervalMs && intervalMs > 0) timer = window.setTimeout(run, intervalMs);
        }
      }
    };

    setLoading(true);
    void run();
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  return { data, error, loading, refresh };
}

/** One-shot loader with a manual refresh, used for tab content that is not live. */
export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[] = []): PollingState<T> {
  return usePolling(loader, null, deps);
}
