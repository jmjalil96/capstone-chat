import type { SessionResponse } from "@capstone/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useOutletContext } from "react-router";

import { type SessionQueryResult, sessionQueryKey } from "../api/session";
import { copy } from "../copy";
import { signOut } from "./auth-actions";
import { FormMessage } from "./form-feedback";
import { IdentityPanel } from "./identity-panel";

export function CheckpointPage() {
  const session = useOutletContext<SessionResponse>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: sessionQueryKey });
      queryClient.setQueryData<SessionQueryResult>(sessionQueryKey, { status: "anonymous" });
      navigate("/sign-in", { replace: true });
    },
  });

  return (
    <IdentityPanel
      eyebrow={copy.identity.checkpoint.eyebrow}
      documentTitle={copy.identity.checkpoint.documentTitle}
      title={copy.identity.checkpoint.title(session.employee.name)}
      description={copy.identity.checkpoint.description}
      wide
    >
      <FormMessage
        kind="error"
        message={mutation.isError ? copy.identity.checkpoint.signOutError : undefined}
      />
      <dl className="session-details">
        <div>
          <dt>{copy.identity.checkpoint.employee}</dt>
          <dd>{session.employee.name}</dd>
        </div>
        <div>
          <dt>{copy.identity.checkpoint.email}</dt>
          <dd>{session.employee.email}</dd>
        </div>
        <div>
          <dt>{copy.identity.checkpoint.workspace}</dt>
          <dd>{session.workspace.name}</dd>
        </div>
        <div>
          <dt>{copy.identity.checkpoint.role}</dt>
          <dd>{copy.identity.roles[session.workspace.role]}</dd>
        </div>
      </dl>
      <div className="checkpoint-actions">
        <Link className="primary-button" to="/account/security">
          {copy.identity.checkpoint.securityLink}
        </Link>
        <button
          className="secondary-button"
          type="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending
            ? copy.identity.checkpoint.signingOut
            : copy.identity.checkpoint.signOut}
        </button>
      </div>
    </IdentityPanel>
  );
}
