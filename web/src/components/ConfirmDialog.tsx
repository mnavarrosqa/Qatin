import { useEffect, useId, useRef } from 'react';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Volver',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    (danger ? cancelRef : confirmRef).current?.focus();
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape' && !busy) onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, danger, onCancel]);

  if (!open) return null;

  return (
    <div
      className="confirm-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onClick={(ev) => ev.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        <div className="confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${danger ? 'btn-danger' : ''}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Un momento…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
