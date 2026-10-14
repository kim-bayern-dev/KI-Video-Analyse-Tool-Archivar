import { createRef, type Ref, type Props, type VNode } from "defuss";
import { Modal } from "../../../cl/components/modal.js";

/**
 * Imperative handle exposed via ref.state.
 *
 * confirm() shows the modal and resolves true (confirm) / false (cancel) —
 * but ONLY via the two footer buttons. Contract caveats callers must know:
 * closing via Esc (closeOnEsc is enabled) or any other UIkit-triggered hide
 * leaves the promise pending forever, and calling confirm() again while one
 * is open overwrites the pending resolver, stranding the first promise.
 */
export interface ConfirmDialogRef {
  confirm: (message: string) => Promise<boolean>;
}

export interface ConfirmDialogProps extends Props {
  ref?: Ref<HTMLDivElement, ConfirmDialogRef>;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmClass?: string;
}

/**
 * Promise-based confirm dialog: await ref.state.confirm(message).
 * Used by the dashboard for the file-delete confirmation — and, as a
 * makeshift alert, for delete-error messages (screens/dashboard.tsx).
 */
export const ConfirmDialog = ({
  ref = createRef<HTMLDivElement, ConfirmDialogRef>(),
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  confirmClass = "uk-btn uk-btn-danger",
}: ConfirmDialogProps) => {

  const modalRef = createRef();
  const messageRef = createRef<HTMLParagraphElement>();
  let resolveFn: ((value: boolean) => void) | null = null;

  // REFACTOR(consistency): (window as any).UIkit bypasses the typed uikit
  // import used in src/cl/functions/notification.ts:1 — the same window-cast
  // recurs in analyze-modal.tsx and upload-wizard.tsx; one small typed
  // helper would kill all of these any-casts at once.
  const show = () => {
    const uk = (window as any).UIkit;
    if (uk && modalRef.current) uk.modal(modalRef.current).show();
  };

  const hide = () => {
    const uk = (window as any).UIkit;
    if (uk && modalRef.current) uk.modal(modalRef.current).hide();
  };

  const onConfirm = () => {
    hide();
    resolveFn?.(true);
    resolveFn = null;
  };

  const onCancel = () => {
    hide();
    resolveFn?.(false);
    resolveFn = null;
  };

  ref.state = {
    ...ref.state,
    confirm: (message: string) => {
      if (messageRef.current) messageRef.current.textContent = message;
      show();
      return new Promise<boolean>((resolve) => { resolveFn = resolve; });
    },
  };

  const footer = (
    <div className="flex justify-end gap-2">
      <button className="uk-btn uk-btn-default" onClick={onCancel}>{cancelLabel}</button>
      <button className={confirmClass} onClick={onConfirm}>{confirmLabel}</button>
    </div>
  ) as VNode;

  return (
    <Modal ref={modalRef} closeOnBg={false} closeOnEsc footer={footer}>
      {(<p ref={messageRef} className="text-base"></p>) as VNode}
    </Modal>
  );
};
