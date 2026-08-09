import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { sessionQueryKey } from "../api/session";
import { copy } from "../copy";
import { sendVerificationEmail, verifyEmail } from "./auth-actions";
import { clearIdentityCredential, readIdentityCredential } from "./credential-fragment";
import { FieldError, FormMessage, useFeedbackAttempt } from "./form-feedback";
import { IdentityPanel } from "./identity-panel";
import { emailError } from "./validation";

export function VerifyEmailPage() {
  const queryClient = useQueryClient();
  const [feedbackAttempt, beginFeedbackAttempt] = useFeedbackAttempt();
  const [emailValidation, setEmailValidation] = useState<string>();
  const [credential] = useState(() => readIdentityCredential("/verify-email"));
  const verificationStarted = useRef(false);
  const verificationMutation = useMutation({
    mutationFn: verifyEmail,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
    onSettled: () => clearIdentityCredential("/verify-email"),
  });
  const resendMutation = useMutation({ mutationFn: sendVerificationEmail });
  const verifyCredential = verificationMutation.mutate;

  useEffect(() => {
    let active = true;

    // React verifies effect cleanup during development. Defer the one-shot mutation so the
    // discarded effect cannot consume it before the live effect owns the request.
    queueMicrotask(() => {
      if (active && credential.token !== null && !verificationStarted.current) {
        verificationStarted.current = true;
        verifyCredential(credential.token);
      }
    });

    return () => {
      active = false;
    };
  }, [credential.token, verifyCredential]);

  useEffect(() => () => clearIdentityCredential("/verify-email"), []);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    beginFeedbackAttempt();
    resendMutation.reset();

    const email = event.currentTarget.elements.namedItem("email") as HTMLInputElement;
    const validation = emailError(email);
    setEmailValidation(validation);

    if (!validation) {
      resendMutation.mutate(email.value.trim());
    }
  }

  if (verificationMutation.isSuccess) {
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

  if (credential.token !== null && !verificationMutation.isError) {
    return (
      <IdentityPanel
        eyebrow={copy.identity.verifyEmail.eyebrow}
        title={copy.identity.verifyEmail.title}
        description={copy.identity.verifyEmail.description}
      >
        <p role="status">{copy.identity.verifyEmail.verifying}</p>
      </IdentityPanel>
    );
  }

  const invalid = credential.invalid || verificationMutation.isError;

  const feedback = emailValidation
    ? copy.identity.common.validationSummary
    : resendMutation.isError
      ? copy.identity.common.genericError
      : resendMutation.isSuccess
        ? copy.identity.verifyEmail.resendSuccess
        : undefined;

  return (
    <IdentityPanel
      eyebrow={copy.identity.verifyEmail.eyebrow}
      title={invalid ? copy.identity.verifyEmail.invalidTitle : copy.identity.verifyEmail.title}
      description={
        invalid ? copy.identity.verifyEmail.invalid : copy.identity.verifyEmail.description
      }
    >
      <h2 className="form-heading">{copy.identity.verifyEmail.resendTitle}</h2>
      <form
        className="identity-form"
        onSubmit={handleSubmit}
        noValidate
        aria-busy={resendMutation.isPending}
      >
        <FormMessage
          focusKey={feedbackAttempt}
          kind={resendMutation.isSuccess ? "success" : "error"}
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
        <button className="primary-button" type="submit" disabled={resendMutation.isPending}>
          {resendMutation.isPending
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
