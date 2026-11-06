import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useToast } from "../../lib/toast";
import { useLoad } from "../../lib/usePolling";
import type { Channel } from "../../lib/types";
import { ChannelsEditor } from "../../components/ChannelsEditor";
import { Button, Card, ErrorNote, Spinner } from "../../components/ui";

export function DefaultChannels() {
  const { can } = useAuth();
  const toast = useToast();
  const channels = useLoad<Channel[]>((signal) => api.get<Channel[]>("/alerts/channels", signal));
  const [value, setValue] = useState<Channel[]>([]);
  const [busy, setBusy] = useState(false);
  const canManage = can("alerts:manage");

  useEffect(() => {
    if (channels.data) setValue(channels.data);
  }, [channels.data]);

  async function save() {
    setBusy(true);
    try {
      await api.put("/alerts/channels", value.filter((c) => c.chat_id.trim()));
      toast.success("Default channels saved");
      channels.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Default delivery channels" subtitle="Used by rules that have no channels of their own. The bot delivers to these chats.">
      <ErrorNote error={channels.error} />
      {channels.loading && !channels.data ? (
        <Spinner />
      ) : (
        <div className="stack">
          <ChannelsEditor value={value} onChange={setValue} disabled={!canManage} />
          {canManage ? (
            <div><Button variant="primary" size="sm" loading={busy} onClick={() => void save()}>Save channels</Button></div>
          ) : (
            <span className="muted-dim">Read-only: you lack alerts:manage</span>
          )}
        </div>
      )}
    </Card>
  );
}
