import capstoneLogo from "@capstone/brand/assets/logos/capstone-primary.svg";
import type { SessionResponse } from "@capstone/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, Outlet, useNavigate, useOutletContext } from "react-router";

import { type SessionQueryResult, sessionQueryKey } from "../api/session";
import { copy } from "../copy";
import { signOut } from "../identity/auth-actions";

export function AdminShell() {
  const session = useOutletContext<SessionResponse>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      await queryClient.cancelQueries();
      queryClient.clear();
      queryClient.setQueryData<SessionQueryResult>(sessionQueryKey, { status: "anonymous" });
      navigate("/sign-in", { replace: true });
    },
  });

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <Link className="admin-brand" to="/" aria-label={copy.brand.homeLabel}>
          <img src={capstoneLogo} alt="" />
        </Link>
        <details className="admin-account-menu">
          <summary aria-label={copy.administration.navigation.account}>
            <span className="account-initial" aria-hidden="true">
              {session.employee.name.trim().charAt(0).toLocaleUpperCase()}
            </span>
            <span>
              <strong>{session.employee.name}</strong>
              <small>{session.workspace.name}</small>
            </span>
          </summary>
          <div className="admin-account-panel">
            <p>{session.employee.email}</p>
            <p>{copy.identity.roles[session.workspace.role]}</p>
            <button
              className="text-button"
              type="button"
              disabled={signOutMutation.isPending}
              onClick={() => signOutMutation.mutate()}
            >
              {signOutMutation.isPending
                ? copy.administration.navigation.signingOut
                : copy.administration.navigation.signOut}
            </button>
          </div>
        </details>
      </header>
      <div className="admin-layout">
        <aside className="admin-sidebar">
          <p>{copy.administration.navigation.label}</p>
          <nav aria-label={copy.administration.navigation.label}>
            <NavLink to="/admin/employees">{copy.administration.navigation.employees}</NavLink>
            <NavLink to="/admin/models">{copy.administration.navigation.models}</NavLink>
            <NavLink to="/admin/usage">{copy.administration.navigation.usage}</NavLink>
          </nav>
          <Link className="admin-back-link" to="/">
            {copy.administration.navigation.backToChat}
          </Link>
        </aside>
        <main className="admin-main" id="main-content">
          {signOutMutation.isError ? (
            <p className="form-message" data-kind="error" role="alert">
              {copy.administration.common.genericError}
            </p>
          ) : null}
          <Outlet context={session} />
        </main>
      </div>
    </div>
  );
}
