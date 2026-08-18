import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { type SessionQueryResult, sessionQueryKey } from "../api/session";
import { copy } from "../copy";
import { signOut } from "../identity/auth-actions";
import { AdministrationApiError } from "./api";

export function administrationErrorMessage(error: unknown): string {
  if (error instanceof AdministrationApiError) {
    if (error.code === "SESSION_REFRESH_REQUIRED") {
      return copy.administration.common.freshSession;
    }
    if (error.code === "MODEL_POLICY_CHANGED") {
      return copy.administration.models.stale;
    }
    if (error.code === "MODEL_POLICY_CONFLICT") {
      return copy.administration.models.conflict;
    }
    if (error.code === "ASSISTANT_RULES_CHANGED") {
      return copy.administration.assistant.stale;
    }
    if (error.code === "ASSISTANT_RULES_CONFLICT") {
      return copy.administration.assistant.conflict;
    }
    if (error.code === "INVITATION_DELIVERY_FAILED") {
      return copy.administration.employees.invitationDeliveryFailed;
    }
    if (error.code === "EMPLOYEE_DEACTIVATION_INCOMPLETE") {
      return copy.administration.employees.deactivationIncomplete;
    }
  }
  return copy.administration.common.genericError;
}

export function AdministrationError({ error }: { readonly error: unknown }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refreshRequired =
    error instanceof AdministrationApiError && error.code === "SESSION_REFRESH_REQUIRED";
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
    <div className="form-message" data-kind="error" role="alert">
      <p>{administrationErrorMessage(error)}</p>
      {refreshRequired ? (
        <button
          className="secondary-button compact-button"
          type="button"
          disabled={signOutMutation.isPending}
          onClick={() => signOutMutation.mutate()}
        >
          {copy.administration.common.signInAgain}
        </button>
      ) : null}
    </div>
  );
}
