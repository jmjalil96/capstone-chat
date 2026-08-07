import type { SessionResponse } from "@capstone/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Navigate, Outlet, useNavigate } from "react-router";

import { type SessionQueryResult, sessionQueryKey, sessionQueryOptions } from "../api/session";
import { copy } from "../copy";
import { signOut } from "./auth-actions";
import { FormMessage } from "./form-feedback";
import { IdentityFrame } from "./identity-layout";
import { IdentityPanel } from "./identity-panel";

export function RequireSession({ standalone = false }: { readonly standalone?: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useQuery(sessionQueryOptions);
  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      await queryClient.cancelQueries();
      queryClient.clear();
      queryClient.setQueryData<SessionQueryResult>(sessionQueryKey, { status: "anonymous" });
      navigate("/sign-in", { replace: true });
    },
  });

  useEffect(() => {
    if (session.data && session.data.status !== "authenticated") {
      queryClient.removeQueries({ queryKey: ["conversations"] });
    }
  }, [queryClient, session.data]);

  let gate: React.ReactNode;

  if (session.isPending) {
    gate = (
      <IdentityPanel
        eyebrow={copy.identity.route.eyebrow}
        title={copy.identity.route.loading}
        description={copy.identity.route.loading}
      >
        <p className="route-status" role="status">
          <span className="status-marker" aria-hidden="true" />
          {copy.identity.route.loading}
        </p>
      </IdentityPanel>
    );
    return standalone ? <IdentityFrame>{gate}</IdentityFrame> : gate;
  }

  if (session.isError) {
    gate = (
      <IdentityPanel
        eyebrow={copy.identity.route.eyebrow}
        title={copy.identity.route.unavailableTitle}
        description={copy.identity.route.unavailable}
      >
        <button className="primary-button" type="button" onClick={() => void session.refetch()}>
          {copy.identity.route.retry}
        </button>
      </IdentityPanel>
    );
    return standalone ? <IdentityFrame>{gate}</IdentityFrame> : gate;
  }

  if (session.data.status === "anonymous") {
    return <Navigate to="/sign-in" replace />;
  }

  if (session.data.status === "denied") {
    gate = (
      <IdentityPanel
        eyebrow={copy.identity.route.eyebrow}
        title={copy.identity.route.deniedTitle}
        description={copy.identity.route.denied}
      >
        <FormMessage
          kind="error"
          message={signOutMutation.isError ? copy.identity.route.signOutError : undefined}
        />
        <button
          className="secondary-button"
          type="button"
          disabled={signOutMutation.isPending}
          onClick={() => signOutMutation.mutate()}
        >
          {signOutMutation.isPending ? copy.identity.route.signingOut : copy.identity.route.signOut}
        </button>
      </IdentityPanel>
    );
    return standalone ? <IdentityFrame>{gate}</IdentityFrame> : gate;
  }

  return <Outlet context={session.data.session satisfies SessionResponse} />;
}
