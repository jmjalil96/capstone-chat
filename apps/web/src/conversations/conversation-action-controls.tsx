import {
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";

import { copy } from "../copy";
import type { ConversationActionController } from "./conversation-actions";
import { Icon } from "./icons";
import { useDisclosureDismissal } from "./use-disclosure-dismissal";

interface ConversationActionDisclosureProps {
  readonly className?: string;
  readonly controller: ConversationActionController;
  readonly label: string;
}

export function ConversationActionDisclosure({
  className,
  controller,
  label,
}: ConversationActionDisclosureProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerElementRef = useRef<HTMLButtonElement | null>(null);
  const disclosureOpenRef = controller.disclosureOpenRef;
  const conversation = controller.conversation;

  const registerDisclosureTrigger = useCallback(
    (trigger: HTMLButtonElement | null) => {
      if (trigger) {
        triggerElementRef.current = trigger;
        controller.registerTrigger(trigger);
      }
    },
    [controller.registerTrigger],
  );

  useDisclosureDismissal({
    close: controller.closeDisclosure,
    containerRef,
    open: controller.disclosureOpen,
    triggerRef: controller.triggerRef,
  });

  useLayoutEffect(() => {
    const trigger = triggerElementRef.current;
    if (!trigger) {
      return undefined;
    }
    controller.registerTrigger(trigger);
    return () => {
      const activeElement = document.activeElement;
      controller.unregisterTrigger(
        trigger,
        disclosureOpenRef.current ||
          activeElement === trigger ||
          (activeElement instanceof Node && Boolean(containerRef.current?.contains(activeElement))),
      );
    };
  }, [controller.registerTrigger, controller.unregisterTrigger, disclosureOpenRef]);

  if (!conversation) {
    return null;
  }

  const wrapperClassName = className
    ? `conversation-action-disclosure ${className}`
    : "conversation-action-disclosure";

  function toggleDisclosure(event: ReactMouseEvent<HTMLButtonElement>): void {
    controller.triggerRef.current = event.currentTarget;
    if (controller.disclosureOpen) {
      controller.closeDisclosure();
    } else {
      const navigation = event.currentTarget.closest<HTMLElement>(".conversation-navigation");
      if (navigation && navigation.scrollHeight > navigation.clientHeight) {
        const navigationBox = navigation.getBoundingClientRect();
        const triggerBox = event.currentTarget.getBoundingClientRect();
        navigation.scrollTop +=
          triggerBox.top - navigationBox.top - (navigation.clientHeight - triggerBox.height) / 2;
      }
      controller.setDisclosureOpen(true);
    }
  }

  return (
    <div className={wrapperClassName} ref={containerRef}>
      <button
        aria-controls={controller.disclosureId}
        aria-expanded={controller.disclosureOpen}
        aria-label={label}
        className="conversation-action-trigger icon-button"
        ref={registerDisclosureTrigger}
        title={label}
        type="button"
        onClick={(event) => toggleDisclosure(event)}
      >
        <Icon name="ellipsis-horizontal" />
      </button>
      {controller.disclosureOpen ? (
        <div className="conversation-action-panel" id={controller.disclosureId}>
          {controller.actionError ? (
            <p
              className="inline-alert conversation-action-alert"
              ref={controller.alertRef}
              role="alert"
              tabIndex={-1}
            >
              <span>{controller.actionError}</span>
              <button
                className="text-button"
                type="button"
                disabled={controller.canonicalRecoveryPending}
                onClick={() => void controller.retryAction()}
              >
                {copy.conversations.common.retry}
              </button>
            </p>
          ) : null}
          <button
            className="conversation-action-row"
            type="button"
            disabled={controller.isPending}
            onClick={() => controller.openRenameDialog()}
          >
            {copy.conversations.conversation.rename}
          </button>
          <button
            className="conversation-action-row"
            type="button"
            disabled={controller.isPending}
            onClick={() => controller.toggleArchive()}
          >
            {conversation.isArchived
              ? copy.conversations.conversation.unarchive
              : copy.conversations.conversation.archive}
          </button>
          <button
            className="conversation-action-row conversation-action-row-danger"
            type="button"
            disabled={controller.isPending}
            onClick={controller.openDeleteDialog}
          >
            <Icon name="trash" />
            {copy.conversations.conversation.delete}
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface ConversationActionDialogsProps {
  readonly controller: ConversationActionController;
}

export function ConversationActionDialogs({ controller }: ConversationActionDialogsProps) {
  const conversation = controller.conversation;
  if (!conversation) {
    return null;
  }

  function submitRename(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (controller.titleValid) {
      controller.setDialogError(undefined);
      controller.rename.mutate();
    }
  }

  function changeTitle(event: ChangeEvent<HTMLInputElement>): void {
    controller.setTitle(event.currentTarget.value);
  }

  return (
    <>
      <dialog
        className="action-dialog"
        ref={controller.renameDialogRef}
        aria-labelledby={controller.renameDialogTitleId}
        onClose={controller.restoreTriggerFocus}
      >
        <form method="dialog" onSubmit={submitRename}>
          <h2 id={controller.renameDialogTitleId}>{copy.conversations.conversation.renameTitle}</h2>
          <label htmlFor={controller.renameInputId}>
            {copy.conversations.conversation.titleLabel}
          </label>
          <input
            id={controller.renameInputId}
            value={controller.title}
            onChange={changeTitle}
            aria-invalid={!controller.titleValid}
            aria-describedby={controller.renameHelpId}
          />
          <p className="field-help" id={controller.renameHelpId}>
            {copy.conversations.conversation.titleHelp}
          </p>
          {controller.dialogError ? <p role="alert">{controller.dialogError}</p> : null}
          <div className="dialog-actions">
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={controller.closeRenameDialog}
            >
              {copy.conversations.conversation.cancel}
            </button>
            <button
              className="primary-button compact-button"
              type="submit"
              disabled={!controller.titleValid || controller.rename.isPending}
            >
              {copy.conversations.conversation.saveTitle}
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        className="action-dialog"
        ref={controller.deleteDialogRef}
        aria-labelledby={controller.deleteDialogTitleId}
        onCancel={(event) => {
          if (controller.remove.isPending) {
            event.preventDefault();
          }
        }}
        onClose={controller.restoreTriggerFocus}
      >
        <h2 id={controller.deleteDialogTitleId}>{copy.conversations.conversation.deleteTitle}</h2>
        <p>{copy.conversations.conversation.deleteNotice}</p>
        {controller.dialogError ? <p role="alert">{controller.dialogError}</p> : null}
        <div className="dialog-actions">
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={controller.remove.isPending}
            onClick={controller.closeDeleteDialog}
          >
            {copy.conversations.conversation.cancel}
          </button>
          <button
            className="danger-button compact-button"
            type="button"
            disabled={controller.remove.isPending}
            onClick={() => {
              controller.setDialogError(undefined);
              controller.beginDelete();
            }}
          >
            {controller.remove.isPending
              ? copy.conversations.conversation.deleting
              : copy.conversations.conversation.confirmDelete}
          </button>
        </div>
      </dialog>
    </>
  );
}
