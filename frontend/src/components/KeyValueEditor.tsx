import { Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "./ui";

export type KV = { key: string; value: string };

/** Converts a string value into a JSON scalar when it looks like a number/bool. */
export function parseScalar(raw: string): unknown {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return raw;
}

export const toPairs = (obj: Record<string, unknown>): KV[] => Object.entries(obj).map(([key, value]) => ({ key, value: typeof value === "string" ? value : JSON.stringify(value) }));
export const fromPairs = (pairs: KV[]): Record<string, unknown> => Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), parseScalar(p.value)]));

export function KeyValueEditor({ value, onChange, hint }: { value: KV[]; onChange: (v: KV[]) => void; hint?: string }) {
  const update = (i: number, patch: Partial<KV>) => onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {value.map((p, i) => (
        <div className="row" key={i}>
          <input className="input mono" style={{ width: 160 }} aria-label="Parameter name" placeholder="name" value={p.key} onChange={(e) => update(i, { key: e.target.value })} />
          <input className="input mono grow" style={{ width: "auto" }} aria-label="Parameter value" placeholder="value" value={p.value} onChange={(e) => update(i, { value: e.target.value })} />
          <IconButton label="Remove parameter" icon={<Trash2 size={13} />} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div className="row">
        <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => onChange([...value, { key: "", value: "" }])}>Add parameter</Button>
        {hint && <span className="muted-dim">{hint}</span>}
      </div>
    </div>
  );
}
