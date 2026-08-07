import type { SessionResponse } from "@capstone/protocol";
import { useCallback, useEffect, useMemo } from "react";
import { Outlet, useBlocker, useOutletContext } from "react-router";

import { copy } from "../copy";
import type { ConversationActorScope, ConversationQueryScope } from "./api";
import { ChatRuntimeProvider } from "./chat-runtime-provider";
import { DraftMemoryProvider, useDraftMemory } from "./draft-memory";

function ProtectedDraftOutlet({ session }: { readonly session: SessionResponse }) {
  const drafts = useDraftMemory();
  const shouldBlockNavigation = useCallback(
    () => drafts.hasUnsavedActiveDraftNow(),
    [drafts.hasUnsavedActiveDraftNow],
  );
  const blocker = useBlocker(shouldBlockNavigation);

  useEffect(() => {
    if (blocker.state !== "blocked") {
      return;
    }

    const blockedNavigation = blocker;
    const capture = drafts.capture();
    let current = true;
    void drafts.flushActiveDraft().then((saved) => {
      if (!current || !drafts.isCurrent(capture)) {
        return;
      }
      if (saved) {
        blockedNavigation.proceed();
      } else {
        blockedNavigation.reset();
      }
    });
    return () => {
      current = false;
    };
  }, [blocker, drafts.capture, drafts.flushActiveDraft, drafts.isCurrent]);

  return (
    <>
      {drafts.hasUnattendedDrafts ? (
        <p className="pending-draft-notice" role="status" aria-live="polite">
          {copy.conversations.draft.pendingNotice}
        </p>
      ) : null}
      <Outlet context={session} />
    </>
  );
}

export function ProtectedDraftLayout() {
  const session = useOutletContext<SessionResponse>();
  const actorScope = useMemo<ConversationActorScope>(
    () => [session.workspace.id, session.employee.id],
    [session.workspace.id, session.employee.id],
  );
  const queryScope = useMemo<ConversationQueryScope>(
    () => [...actorScope, session.session.createdAt],
    [actorScope, session.session.createdAt],
  );

  return (
    <DraftMemoryProvider key={JSON.stringify(actorScope)} queryScope={queryScope}>
      <ChatRuntimeProvider>
        <ProtectedDraftOutlet session={session} />
      </ChatRuntimeProvider>
    </DraftMemoryProvider>
  );
}
