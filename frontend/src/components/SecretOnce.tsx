import { Copy } from "lucide-react";
import { useToast } from "../lib/toast";
import { Button } from "./ui";

/** Shows a secret exactly once (kept only in component state, never persisted). */
export function SecretOnce({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  const toast = useToast();
  return (
    <div className="notice notice-warn stack" style={{ gap: 6 }}>
      <span>{label}</span>
      <div className="row">
        <code className="mono code-block grow" style={{ maxHeight: "none", userSelect: "all" }}>{value}</code>
        <Button size="sm" icon={<Copy size={13} />} onClick={() => navigator.clipboard.writeText(value).then(() => toast.success("Copied"), () => toast.error("Clipboard unavailable"))}>
          Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>Done</Button>
      </div>
    </div>
  );
}
