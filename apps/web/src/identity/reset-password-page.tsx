import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { Link } from "react-router";

import { copy } from "../copy";
import { resetPassword } from "./auth-actions";
import { FieldError, FormMessage, useFeedbackAttempt } from "./form-feedback";
import { IdentityPanel } from "./identity-panel";
import {
  confirmationError,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordError,
} from "./validation";

type ResetErrors = {
  password: string | undefined;
  confirmation: string | undefined;
};

export function ResetPasswordPage() {
  const queryClient = useQueryClient();
  const [feedbackAttempt, beginFeedbackAttempt] = useFeedbackAttempt();
  const [errors, setErrors] = useState<ResetErrors>({
    password: undefined,
    confirmation: undefined,
  });
  const [{ invalid, token }] = useState(() => {
    const parameters = new URLSearchParams(window.location.search);
    return {
      invalid: parameters.has("error"),
      token: parameters.get("token"),
    };
  });
  const mutation = useMutation({
    mutationFn: resetPassword,
    onSuccess: async () => {
      await queryClient.cancelQueries();
      queryClient.clear();
    },
  });

  useLayoutEffect(() => {
    if (window.location.search) {
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
  }, []);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    beginFeedbackAttempt();
    mutation.reset();

    const form = event.currentTarget;
    const password = form.elements.namedItem("password") as HTMLInputElement;
    const confirmation = form.elements.namedItem("confirmation") as HTMLInputElement;
    const nextErrors: ResetErrors = {
      password: passwordError(password.value),
      confirmation: confirmationError(password.value, confirmation.value),
    };

    setErrors(nextErrors);

    if (nextErrors.password || nextErrors.confirmation || !token) {
      return;
    }

    mutation.mutate({ newPassword: password.value, token });
  }

  if (invalid || !token) {
    return (
      <IdentityPanel
        eyebrow={copy.identity.resetPassword.eyebrow}
        title={copy.identity.resetPassword.invalidTitle}
        description={copy.identity.resetPassword.invalid}
      >
        <Link className="text-link" to="/forgot-password">
          {copy.identity.resetPassword.requestNewLink}
        </Link>
      </IdentityPanel>
    );
  }

  if (mutation.isSuccess) {
    return (
      <IdentityPanel
        eyebrow={copy.identity.resetPassword.eyebrow}
        title={copy.identity.resetPassword.successTitle}
        description={copy.identity.resetPassword.success}
      >
        <FormMessage kind="success" message={copy.identity.resetPassword.success} />
        <Link className="text-link" to="/sign-in">
          {copy.identity.common.goToSignIn}
        </Link>
      </IdentityPanel>
    );
  }

  const feedback = Object.values(errors).some(Boolean)
    ? copy.identity.common.validationSummary
    : mutation.isError
      ? copy.identity.common.genericError
      : undefined;

  return (
    <IdentityPanel
      eyebrow={copy.identity.resetPassword.eyebrow}
      title={copy.identity.resetPassword.title}
      description={copy.identity.resetPassword.description}
    >
      <form
        className="identity-form"
        onSubmit={handleSubmit}
        noValidate
        aria-busy={mutation.isPending}
      >
        <FormMessage focusKey={feedbackAttempt} kind="error" message={feedback} />
        <div className="form-field">
          <label htmlFor="reset-password">{copy.identity.common.newPasswordLabel}</label>
          <input
            id="reset-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            required
            aria-invalid={Boolean(errors.password)}
            aria-describedby={`reset-password-help${errors.password ? " reset-password-error" : ""}`}
          />
          <p className="field-help" id="reset-password-help">
            {copy.identity.common.passwordHelp}
          </p>
          <FieldError id="reset-password-error" message={errors.password} />
        </div>
        <div className="form-field">
          <label htmlFor="reset-confirmation">{copy.identity.common.confirmPasswordLabel}</label>
          <input
            id="reset-confirmation"
            name="confirmation"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            required
            aria-invalid={Boolean(errors.confirmation)}
            aria-describedby={errors.confirmation ? "reset-confirmation-error" : undefined}
          />
          <FieldError id="reset-confirmation-error" message={errors.confirmation} />
        </div>
        <button className="primary-button" type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? copy.identity.resetPassword.submitting
            : copy.identity.resetPassword.submit}
        </button>
      </form>
    </IdentityPanel>
  );
}
