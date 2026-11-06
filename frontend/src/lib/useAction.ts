import { useCallback, useState } from "react";
import { errorMessage } from "./api";
import { useToast } from "./toast";

/** Wraps a mutation: tracks busy state, toasts success/failure, never throws. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined> => {
      setBusy(key);
      try {
        const result = await fn();
        if (success) toast.success(typeof success === "function" ? success(result) : success);
        return result;
      } catch (err) {
        toast.error(errorMessage(err));
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  return { busy, run };
}
