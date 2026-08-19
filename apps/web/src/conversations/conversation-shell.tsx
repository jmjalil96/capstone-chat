import capstoneSymbol from "@capstone/brand/assets/logos/capstone-icon.svg";
import capstoneLogo from "@capstone/brand/assets/logos/capstone-primary.svg";
import type { ConversationSummary, SessionResponse } from "@capstone/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Link,
  matchPath,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
} from "react-router";

import { type SessionQueryResult, sessionQueryKey } from "../api/session";
import { copy } from "../copy";
import { signOut } from "../identity/auth-actions";
import { ReadinessIndicator } from "../readiness-indicator";
import {
  ConversationActionDialogs,
  ConversationActionDisclosure,
} from "./conversation-action-controls";
import { useConversationActions } from "./conversation-actions";
import { useConversationDetail } from "./conversation-detail";
import { ConversationHistory } from "./conversation-history";
import { useDraftMemory } from "./draft-memory";
import { Icon } from "./icons";
import { NetworkStatus } from "./network-status";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./sidebar-preference";
import { useMobileShell } from "./use-mobile-shell";

interface SidebarContentsProps {
  readonly collapsed: boolean;
  readonly currentActions?: ReactNode;
  readonly currentConversation: ConversationSummary | undefined;
  readonly currentConversationId: string | undefined;
  readonly currentConversationPending: boolean;
  readonly historyHeadingId: string;
  readonly onNavigate: () => void;
  readonly session: SessionResponse;
  readonly signOutError: string | undefined;
  readonly signingOut: boolean;
  readonly onSignOut: () => void;
}

function SidebarContents({
  collapsed,
  currentActions,
  currentConversation,
  currentConversationId,
  currentConversationPending,
  historyHeadingId,
  onNavigate,
  onSignOut,
  session,
  signOutError,
  signingOut,
}: SidebarContentsProps) {
  const currentTitle = currentConversation?.title ?? copy.conversations.common.untitled;
  const currentLinkLabel = currentConversation?.isArchived
    ? `${currentTitle}, ${copy.conversations.conversation.archivedState}`
    : undefined;

  return (
    <div className="sidebar-contents" data-collapsed={collapsed}>
      <Link
        className="conversation-brand"
        to="/"
        onClick={onNavigate}
        aria-label={copy.brand.homeLabel}
      >
        <img className="conversation-logo" src={collapsed ? capstoneSymbol : capstoneLogo} alt="" />
      </Link>
      <nav className="conversation-navigation" aria-label={copy.conversations.navigation.label}>
        <NavLink
          className="sidebar-primary-link"
          to="/"
          onClick={onNavigate}
          aria-label={copy.conversations.common.newChat}
          title={copy.conversations.common.newChat}
          end
        >
          <Icon name="plus" />
          <span>{copy.conversations.common.newChat}</span>
        </NavLink>
        <NavLink
          className="sidebar-link"
          to="/search"
          onClick={onNavigate}
          aria-label={copy.conversations.navigation.search}
          title={copy.conversations.navigation.search}
        >
          <Icon name="search" />
          <span>{copy.conversations.navigation.search}</span>
        </NavLink>
        {currentConversation ? (
          <section
            aria-label={copy.conversations.navigation.current}
            className="current-conversation"
          >
            <p className="current-conversation-label">{copy.conversations.navigation.current}</p>
            <div className="current-conversation-row">
              <NavLink
                aria-label={currentLinkLabel}
                className="current-conversation-link"
                to={`/c/${currentConversation.id}`}
                onClick={onNavigate}
                title={currentTitle}
              >
                <span>{currentTitle}</span>
                {currentConversation.isArchived ? (
                  <small>{copy.conversations.conversation.archivedState}</small>
                ) : null}
              </NavLink>
              {currentActions}
            </div>
          </section>
        ) : currentConversationPending ? (
          <section
            aria-hidden="true"
            className="current-conversation current-conversation-placeholder"
          >
            <p className="current-conversation-label">{copy.conversations.navigation.current}</p>
            <div className="current-conversation-row">
              <span className="current-conversation-link">
                <span className="current-conversation-title-placeholder" />
              </span>
              <span className="conversation-action-placeholder" />
            </div>
          </section>
        ) : null}
        <section className="recent-section" aria-labelledby={historyHeadingId}>
          <h2 id={historyHeadingId}>{copy.conversations.navigation.recent}</h2>
          {collapsed ? null : (
            <ConversationHistory
              excludeConversationId={currentConversationId}
              view="active"
              onNavigate={onNavigate}
            />
          )}
        </section>
        <NavLink
          className="sidebar-link"
          to="/archived"
          onClick={onNavigate}
          aria-label={copy.conversations.navigation.archived}
          title={copy.conversations.navigation.archived}
        >
          <Icon name="archive" />
          <span>{copy.conversations.navigation.archived}</span>
        </NavLink>
      </nav>
      <div className="sidebar-footer">
        <ReadinessIndicator />
        <details className="account-menu">
          <summary aria-label={copy.conversations.navigation.account}>
            <span className="account-initial" aria-hidden="true">
              {session.employee.name.trim().charAt(0).toLocaleUpperCase()}
            </span>
            <span className="account-copy">
              <strong>{session.employee.name}</strong>
              <span>{session.workspace.name}</span>
            </span>
          </summary>
          <div className="account-menu-panel">
            <p className="account-email">{session.employee.email}</p>
            <p className="account-role">{copy.identity.roles[session.workspace.role]}</p>
            {session.workspace.role === "admin" ? (
              <Link to="/admin/employees" onClick={onNavigate}>
                <Icon name="settings" />
                {copy.administration.navigation.label}
              </Link>
            ) : null}
            <Link to="/account/security" onClick={onNavigate}>
              <Icon name="settings" />
              {copy.conversations.navigation.security}
            </Link>
            {signOutError ? (
              <p className="account-error" role="alert">
                {signOutError}
              </p>
            ) : null}
            <button type="button" disabled={signingOut} onClick={onSignOut}>
              {signingOut
                ? copy.conversations.navigation.signingOut
                : copy.conversations.navigation.signOut}
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}

export function ConversationShell() {
  const session = useOutletContext<SessionResponse>();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const draftMemory = useDraftMemory();
  const mobile = useMobileShell();
  const [collapsed, setCollapsed] = useState(() => readSidebarCollapsed());
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const signOutCaptureRef = useRef<AbortSignal | undefined>(undefined);
  const captureGeneration = draftMemory.capture;
  const isGenerationCurrent = draftMemory.isCurrent;
  const conversationRoute = matchPath({ path: "/c/:conversationId", end: true }, location.pathname);
  const currentConversationId = conversationRoute?.params.conversationId;
  const currentDetail = useConversationDetail(currentConversationId);
  const currentConversation = currentDetail.data?.pages[0]?.conversation;
  const currentConversationPending = Boolean(currentConversationId && currentDetail.isPending);
  const conversationActions = useConversationActions(currentConversation);
  const currentTitle = currentConversation?.title ?? copy.conversations.common.untitled;
  const currentActionLabel = copy.conversations.conversation.actionsLabel(currentTitle);
  const showCollapsedContext = Boolean(
    !mobile && collapsed && (currentConversation || currentConversationPending),
  );

  const signOutMutation = useMutation({
    mutationFn: async () => {
      const capture = captureGeneration();
      signOutCaptureRef.current = capture;
      setSignOutError(undefined);
      if (!(await draftMemory.flushActiveDraft()) || draftMemory.hasUnsavedDraftsNow()) {
        throw new Error("draft-not-saved");
      }
      if (!isGenerationCurrent(capture)) {
        throw new Error("session-changed");
      }
      await signOut();
      if (!isGenerationCurrent(capture)) {
        throw new Error("session-changed");
      }
    },
    onSuccess: async () => {
      const capture = signOutCaptureRef.current;
      if (!capture || !isGenerationCurrent(capture)) {
        return;
      }
      await queryClient.cancelQueries();
      if (!isGenerationCurrent(capture)) {
        return;
      }
      queryClient.clear();
      queryClient.setQueryData<SessionQueryResult>(sessionQueryKey, { status: "anonymous" });
      navigate("/sign-in", { replace: true });
    },
    onError: (error) => {
      const capture = signOutCaptureRef.current;
      if (!capture || !isGenerationCurrent(capture)) {
        return;
      }
      draftMemory.unlockEditing();
      setSignOutError(
        error instanceof Error && error.message === "draft-not-saved"
          ? copy.conversations.navigation.signOutDraftError
          : copy.conversations.navigation.signOutError,
      );
    },
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (mobileOpen && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    } else if (!mobileOpen && dialog.open) {
      dialog.close();
    }
  }, [mobileOpen]);

  useEffect(() => {
    if (mobile || !mobileOpen) {
      return;
    }
    if (dialogRef.current?.open) {
      dialogRef.current.close();
    } else {
      setMobileOpen(false);
    }
  }, [mobile, mobileOpen]);

  function closeMobileSidebar() {
    setMobileOpen(false);
  }

  function restoreMenuFocus() {
    setMobileOpen(false);
    if (mobile) {
      menuButtonRef.current?.focus();
    } else if (currentConversation) {
      conversationActions.restoreTriggerFocus();
    } else {
      collapseButtonRef.current?.focus();
    }
  }

  const sidebarProps = {
    currentConversation,
    currentConversationId,
    currentConversationPending,
    onNavigate: closeMobileSidebar,
    onSignOut: () => {
      draftMemory.lockEditing();
      signOutMutation.mutate();
    },
    session,
    signOutError,
    signingOut: signOutMutation.isPending,
  } as const;

  return (
    <div
      className="conversation-shell"
      data-sidebar-collapsed={collapsed}
      onClickCapture={(event) => {
        const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
        if (
          !anchor ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          anchor.target === "_blank"
        ) {
          return;
        }

        const destination = new URL(anchor.href, window.location.href);
        if (destination.origin !== window.location.origin) {
          return;
        }

        event.preventDefault();
        const capture = captureGeneration();
        void draftMemory.flushActiveDraft().then((saved) => {
          if (saved && isGenerationCurrent(capture)) {
            navigate(`${destination.pathname}${destination.search}${destination.hash}`);
          }
        });
      }}
    >
      <NetworkStatus />
      <aside className="desktop-sidebar">
        <SidebarContents
          collapsed={collapsed}
          currentActions={
            !mobile && !collapsed && currentConversation ? (
              <ConversationActionDisclosure
                controller={conversationActions}
                label={currentActionLabel}
              />
            ) : undefined
          }
          historyHeadingId="desktop-recent-heading"
          {...sidebarProps}
        />
        <button
          className="sidebar-collapse-button icon-button"
          ref={collapseButtonRef}
          type="button"
          onClick={() => {
            conversationActions.closeDisclosure({ restoreFocus: false });
            const next = !collapsed;
            setCollapsed(next);
            writeSidebarCollapsed(next);
          }}
          aria-label={
            collapsed
              ? copy.conversations.navigation.expand
              : copy.conversations.navigation.collapse
          }
          title={
            collapsed
              ? copy.conversations.navigation.expand
              : copy.conversations.navigation.collapse
          }
        >
          <Icon name={collapsed ? "chevron-right" : "chevron-left"} />
        </button>
      </aside>
      <header className="mobile-conversation-header">
        <button
          className="icon-button"
          ref={menuButtonRef}
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={mobileOpen}
          aria-label={copy.conversations.navigation.open}
        >
          <Icon name="menu" />
        </button>
        {currentConversation ? (
          <>
            <Link
              aria-label={
                currentConversation.isArchived
                  ? `${currentTitle}, ${copy.conversations.conversation.archivedState}`
                  : undefined
              }
              className="mobile-current-conversation"
              to={`/c/${currentConversation.id}`}
              title={currentTitle}
            >
              <span>{currentTitle}</span>
              {currentConversation.isArchived ? (
                <small>{copy.conversations.conversation.archivedState}</small>
              ) : null}
            </Link>
            {mobile ? (
              <ConversationActionDisclosure
                controller={conversationActions}
                label={currentActionLabel}
              />
            ) : null}
          </>
        ) : currentConversationPending ? (
          <>
            <span
              aria-hidden="true"
              className="mobile-current-conversation current-conversation-placeholder"
            >
              <span className="current-conversation-title-placeholder" />
            </span>
            <span aria-hidden="true" className="conversation-action-placeholder" />
          </>
        ) : (
          <Link to="/" aria-label={copy.brand.homeLabel}>
            <img src={capstoneLogo} alt="" />
          </Link>
        )}
      </header>
      <dialog
        className="mobile-sidebar-dialog"
        ref={dialogRef}
        aria-label={copy.conversations.navigation.label}
        onCancel={(event) => {
          event.preventDefault();
          dialogRef.current?.close();
        }}
        onClose={restoreMenuFocus}
      >
        <button
          className="mobile-sidebar-close icon-button"
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label={copy.conversations.navigation.close}
        >
          <Icon name="close" />
        </button>
        <SidebarContents
          collapsed={false}
          currentConversation={currentConversation}
          currentConversationId={currentConversationId}
          currentConversationPending={currentConversationPending}
          historyHeadingId="mobile-recent-heading"
          onNavigate={sidebarProps.onNavigate}
          onSignOut={sidebarProps.onSignOut}
          session={sidebarProps.session}
          signOutError={sidebarProps.signOutError}
          signingOut={sidebarProps.signingOut}
        />
      </dialog>
      <main
        className="conversation-main"
        data-context-strip={showCollapsedContext}
        id="main-content"
      >
        {showCollapsedContext ? (
          <div className="conversation-context-strip">
            {currentConversation ? (
              <>
                <Link
                  aria-label={
                    currentConversation.isArchived
                      ? `${currentTitle}, ${copy.conversations.conversation.archivedState}`
                      : undefined
                  }
                  className="conversation-context-link"
                  to={`/c/${currentConversation.id}`}
                  title={currentTitle}
                >
                  <span>{currentTitle}</span>
                  {currentConversation.isArchived ? (
                    <small>{copy.conversations.conversation.archivedState}</small>
                  ) : null}
                </Link>
                <ConversationActionDisclosure
                  controller={conversationActions}
                  label={currentActionLabel}
                />
              </>
            ) : (
              <>
                <span
                  aria-hidden="true"
                  className="conversation-context-link current-conversation-placeholder"
                >
                  <span className="current-conversation-title-placeholder" />
                </span>
                <span aria-hidden="true" className="conversation-action-placeholder" />
              </>
            )}
          </div>
        ) : null}
        <div className="conversation-route">
          <Outlet context={session} />
        </div>
      </main>
      <ConversationActionDialogs controller={conversationActions} />
    </div>
  );
}
