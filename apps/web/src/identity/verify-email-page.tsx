import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { Link } from "react-router";

import { sessionQueryKey } from "../api/session";
import { copy } from "../copy";
import { sendVerificationEmail } from "./auth-actions";
import { FieldError, FormMessage, useFeedbackAttempt } from "./form-feedback";
import { IdentityPanel } from "./identity-panel";
import { emailError } from "./validation";

type Arrival = "pending" | "verified" | "invalid";

export function VerifyEmailPage() {
  const queryClient = useQueryClient();
  const [feedbackAttempt, beginFeedbackAttempt] = useFeedbackAttempt();
  const [emailValidation, setEmailValidation] = useState<string>();
  const [arrival] = useState<Arrival>(() => {
    const parameters = new URLSearchParams(window.location.search);

    if (parameters.has("error")) {
      return "invalid";
    }

    return parameters.get("verified") === "1" ? "verified" : "pending";
  });
  const mutation = useMutation({ mutationFn: sendVerificationEmail });

  useLayoutEffect(() => {
    if (window.location.search) {
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }

    if (arrival === "verified") {
      void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    }
  }, [arrival, queryClient]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    beginFeedbackAttempt();
    mutation.reset();

    const email = event.currentTarget.elements.namedItem("email") as HTMLInputElement;
    const validation = emailError(email);
    setEmailValidation(validation);

    if (!validation) {
      mutation.mutate(email.value.trim());
    }
  }

  if (arrival === "verified") {
    return (
      <IdentityPanel
        eyebrow={copy.identity.verifyEmail.eyebrow}
        title={copy.identity.verifyEmail.verifiedTitle}
        description={copy.identity.verifyEmail.verified}
      >
        <FormMessage kind="success" message={copy.identity.verifyEmail.verified} />
        <Link className="text-link" to="/sign-in">
          {copy.identity.common.goToSignIn}
        </Link>
      </IdentityPanel>
    );
  }

  const feedback = emailValidation
    ? copy.identity.common.validationSummary
    : mutation.isError
      ? copy.identity.common.genericError
      : mutation.isSuccess
        ? copy.identity.verifyEmail.resendSuccess
        : undefined;

  return (
    <IdentityPanel
      eyebrow={copy.identity.verifyEmail.eyebrow}
      title={
        arrival === "invalid"
          ? copy.identity.verifyEmail.invalidTitle
          : copy.identity.verifyEmail.title
      }
      description={
        arrival === "invalid"
          ? copy.identity.verifyEmail.invalid
          : copy.identity.verifyEmail.description
      }
    >
      <h2 className="form-heading">{copy.identity.verifyEmail.resendTitle}</h2>
      <form
        className="identity-form"
        onSubmit={handleSubmit}
        noValidate
        aria-busy={mutation.isPending}
      >
        <FormMessage
          focusKey={feedbackAttempt}
          kind={mutation.isSuccess ? "success" : "error"}
          message={feedback}
        />
        <div className="form-field">
          <label htmlFor="verification-email">{copy.identity.common.emailLabel}</label>
          <input
            id="verification-email"
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-invalid={Boolean(emailValidation)}
            aria-describedby={emailValidation ? "verification-email-error" : undefined}
          />
          <FieldError id="verification-email-error" message={emailValidation} />
        </div>
        <button className="primary-button" type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? copy.identity.verifyEmail.resending
            : copy.identity.verifyEmail.resend}
        </button>
      </form>
      <Link className="text-link" to="/sign-in">
        {copy.identity.common.goToSignIn}
      </Link>
    </IdentityPanel>
  );
}
