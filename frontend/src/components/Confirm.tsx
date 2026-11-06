import { useState, type ReactNode } from "react";
import { Button, Modal } from "./ui";

/** Confirmation dialog; optional `requireText` makes the user type a value (e.g. the slug). */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  requireText,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireText?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const blocked = requireText !== undefined && typed !== requireText;
  const close = () => {
    setTyped("");
    onClose();
  };
  return (
    <Modal
      open={open}
      title={title}
      onClose={close}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={blocked}
            loading={busy}
            onClick={() => {
              onConfirm();
              setTyped("");
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div>{message}</div>
        {requireText !== undefined && (
          <label className="field">
            <span className="field-label">
              Type <code className="mono">{requireText}</code> to confirm
            </span>
            <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
        )}
      </div>
    </Modal>
  );
}
