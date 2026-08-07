import type { SessionResponse } from "@capstone/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Outlet, useNavigate } from "react-router";

import { type SessionQueryResult, sessionQueryKey, sessionQueryOptions } from "../api/session";
import { copy } from "../copy";
import { signOut } from "./auth-actions";
import { FormMessage } from "./form-feedback";
import { IdentityPanel } from "./identity-panel";

export function RequireSession() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useQuery(sessionQueryOptions);
  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: sessionQueryKey });
      queryClient.setQueryData<SessionQueryResult>(sessionQueryKey, { status: "anonymous" });
      navigate("/sign-in", { replace: true });
    },
  });

  if (session.isPending) {
    return (
      <IdentityPanel
        eyebrow={copy.identity.checkpoint.eyebrow}
        title={copy.identity.route.loading}
        description={copy.identity.route.loading}
      >
        <p className="route-status" role="status">
          <span className="status-marker" aria-hidden="true" />
          {copy.identity.route.loading}
        </p>
      </IdentityPanel>
    );
  }

  if (session.isError) {
    return (
      <IdentityPanel
        eyebrow={copy.identity.checkpoint.eyebrow}
        title={copy.identity.route.unavailableTitle}
        description={copy.identity.route.unavailable}
      >
        <button className="primary-button" type="button" onClick={() => void session.refetch()}>
          {copy.identity.route.retry}
        </button>
      </IdentityPanel>
    );
  }

  if (session.data.status === "anonymous") {
    return <Navigate to="/sign-in" replace />;
  }

  if (session.data.status === "denied") {
    return (
      <IdentityPanel
        eyebrow={copy.identity.checkpoint.eyebrow}
        title={copy.identity.route.deniedTitle}
        description={copy.identity.route.denied}
      >
        <FormMessage
          kind="error"
          message={signOutMutation.isError ? copy.identity.checkpoint.signOutError : undefined}
        />
        <button
          className="secondary-button"
          type="button"
          disabled={signOutMutation.isPending}
          onClick={() => signOutMutation.mutate()}
        >
          {signOutMutation.isPending
            ? copy.identity.checkpoint.signingOut
            : copy.identity.checkpoint.signOut}
        </button>
      </IdentityPanel>
    );
  }

  return <Outlet context={session.data.session satisfies SessionResponse} />;
}
