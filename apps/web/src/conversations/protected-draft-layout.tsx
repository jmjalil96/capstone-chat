import type { SessionResponse } from "@capstone/protocol";
import { useCallback, useEffect, useMemo } from "react";
import { Outlet, useBlocker, useOutletContext } from "react-router";

import { copy } from "../copy";
import { conversationActorScope, conversationQueryScope } from "./api";
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
  const actorScope = useMemo(() => conversationActorScope(session), [session]);
  const queryScope = useMemo(() => conversationQueryScope(session), [session]);

  return (
    <DraftMemoryProvider key={JSON.stringify(actorScope)} queryScope={queryScope}>
      <ProtectedDraftOutlet session={session} />
    </DraftMemoryProvider>
  );
}
