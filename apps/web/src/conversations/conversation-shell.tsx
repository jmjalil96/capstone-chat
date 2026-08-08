import capstoneSymbol from "@capstone/brand/assets/logos/capstone-icon.svg";
import capstoneLogo from "@capstone/brand/assets/logos/capstone-primary.svg";
import type { SessionResponse } from "@capstone/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useNavigate, useOutletContext } from "react-router";

import { type SessionQueryResult, sessionQueryKey } from "../api/session";
import { copy } from "../copy";
import { signOut } from "../identity/auth-actions";
import { ReadinessIndicator } from "../readiness-indicator";
import { ConversationHistory } from "./conversation-history";
import { useDraftMemory } from "./draft-memory";
import { Icon } from "./icons";
import { NetworkStatus } from "./network-status";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./sidebar-preference";

interface SidebarContentsProps {
  readonly collapsed: boolean;
  readonly historyHeadingId: string;
  readonly onNavigate: () => void;
  readonly session: SessionResponse;
  readonly signOutError: string | undefined;
  readonly signingOut: boolean;
  readonly onSignOut: () => void;
}

function SidebarContents({
  collapsed,
  historyHeadingId,
  onNavigate,
  onSignOut,
  session,
  signOutError,
  signingOut,
}: SidebarContentsProps) {
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
        <section className="recent-section" aria-labelledby={historyHeadingId}>
          <h2 id={historyHeadingId}>{copy.conversations.navigation.recent}</h2>
          {collapsed ? null : <ConversationHistory view="active" onNavigate={onNavigate} />}
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
  const navigate = useNavigate();
  const draftMemory = useDraftMemory();
  const [collapsed, setCollapsed] = useState(() => readSidebarCollapsed());
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const signOutCaptureRef = useRef<AbortSignal | undefined>(undefined);
  const captureGeneration = draftMemory.capture;
  const isGenerationCurrent = draftMemory.isCurrent;

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

  function closeMobileSidebar() {
    setMobileOpen(false);
  }

  function restoreMenuFocus() {
    setMobileOpen(false);
    menuButtonRef.current?.focus();
  }

  const sidebarProps = {
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
          historyHeadingId="desktop-recent-heading"
          {...sidebarProps}
        />
        <button
          className="sidebar-collapse-button icon-button"
          type="button"
          onClick={() => {
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
        <Link to="/" aria-label={copy.brand.homeLabel}>
          <img src={capstoneLogo} alt="" />
        </Link>
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
          historyHeadingId="mobile-recent-heading"
          {...sidebarProps}
        />
      </dialog>
      <main className="conversation-main" id="main-content">
        <Outlet context={session} />
      </main>
    </div>
  );
}
