import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";

import { copy } from "../copy";
import { requestPasswordReset } from "./auth-actions";
import { FieldError, FormMessage, useFeedbackAttempt } from "./form-feedback";
import { IdentityPanel } from "./identity-panel";
import { emailError } from "./validation";

export function ForgotPasswordPage() {
  const [emailValidation, setEmailValidation] = useState<string>();
  const [feedbackAttempt, beginFeedbackAttempt] = useFeedbackAttempt();
  const mutation = useMutation({ mutationFn: requestPasswordReset });

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

  if (mutation.isSuccess) {
    return (
      <IdentityPanel
        eyebrow={copy.identity.forgotPassword.eyebrow}
        title={copy.identity.forgotPassword.successTitle}
        description={copy.identity.forgotPassword.success}
      >
        <FormMessage kind="success" message={copy.identity.forgotPassword.success} />
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
      : undefined;

  return (
    <IdentityPanel
      eyebrow={copy.identity.forgotPassword.eyebrow}
      title={copy.identity.forgotPassword.title}
      description={copy.identity.forgotPassword.description}
    >
      <form
        className="identity-form"
        onSubmit={handleSubmit}
        noValidate
        aria-busy={mutation.isPending}
      >
        <FormMessage focusKey={feedbackAttempt} kind="error" message={feedback} />
        <div className="form-field">
          <label htmlFor="recovery-email">{copy.identity.common.emailLabel}</label>
          <input
            id="recovery-email"
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-invalid={Boolean(emailValidation)}
            aria-describedby={emailValidation ? "recovery-email-error" : undefined}
          />
          <FieldError id="recovery-email-error" message={emailValidation} />
        </div>
        <button className="primary-button" type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? copy.identity.forgotPassword.submitting
            : copy.identity.forgotPassword.submit}
        </button>
      </form>
      <Link className="text-link" to="/sign-in">
        {copy.identity.common.goToSignIn}
      </Link>
    </IdentityPanel>
  );
}
