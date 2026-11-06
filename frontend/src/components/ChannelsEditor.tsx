import { Plus, Trash2 } from "lucide-react";
import type { Channel } from "../lib/types";
import { Button, IconButton } from "./ui";

export function ChannelsEditor({ value, onChange, disabled }: { value: Channel[]; onChange: (v: Channel[]) => void; disabled?: boolean }) {
  const update = (i: number, patch: Partial<Channel>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {value.length === 0 && <span className="muted-dim">No channels — default channels are used.</span>}
      {value.map((c, i) => (
        <div className="row" key={i}>
          <select className="select" style={{ width: 120 }} aria-label="Platform" value={c.platform} disabled={disabled} onChange={(e) => update(i, { platform: e.target.value as Channel["platform"] })}>
            <option value="discord">Discord</option>
            <option value="telegram">Telegram</option>
          </select>
          <input className="input mono grow" style={{ width: "auto" }} aria-label="Chat or channel id" placeholder="chat / channel id" value={c.chat_id} disabled={disabled} onChange={(e) => update(i, { chat_id: e.target.value })} />
          <IconButton label="Remove channel" icon={<Trash2 size={13} />} disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      {!disabled && (
        <div>
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => onChange([...value, { platform: "discord", chat_id: "" }])}>Add channel</Button>
        </div>
      )}
    </div>
  );
}
