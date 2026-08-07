import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router";

import { sessionQueryKey } from "../api/session";
import { copy } from "../copy";
import { changePassword } from "./auth-actions";
import { FieldError, FormMessage, useFeedbackAttempt } from "./form-feedback";
import { IdentityPanel } from "./identity-panel";
import {
  confirmationError,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordError,
} from "./validation";

type SecurityErrors = {
  currentPassword: string | undefined;
  newPassword: string | undefined;
  confirmation: string | undefined;
};

export function AccountSecurityPage() {
  const formRef = useRef<HTMLFormElement>(null);
  const [feedbackAttempt, beginFeedbackAttempt] = useFeedbackAttempt();
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<SecurityErrors>({
    currentPassword: undefined,
    newPassword: undefined,
    confirmation: undefined,
  });
  const mutation = useMutation({
    mutationFn: changePassword,
    onSuccess: async () => {
      formRef.current?.reset();
      setErrors({ currentPassword: undefined, newPassword: undefined, confirmation: undefined });
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    beginFeedbackAttempt();
    mutation.reset();

    const form = event.currentTarget;
    const currentPassword = form.elements.namedItem("currentPassword") as HTMLInputElement;
    const newPassword = form.elements.namedItem("newPassword") as HTMLInputElement;
    const confirmation = form.elements.namedItem("confirmation") as HTMLInputElement;
    const nextErrors: SecurityErrors = {
      currentPassword: passwordError(currentPassword.value),
      newPassword: passwordError(newPassword.value),
      confirmation: confirmationError(newPassword.value, confirmation.value),
    };

    setErrors(nextErrors);

    if (Object.values(nextErrors).some(Boolean)) {
      return;
    }

    mutation.mutate({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
  }

  const feedback = Object.values(errors).some(Boolean)
    ? copy.identity.common.validationSummary
    : mutation.isError
      ? copy.identity.security.error
      : mutation.isSuccess
        ? copy.identity.security.success
        : undefined;

  return (
    <IdentityPanel
      eyebrow={copy.identity.security.eyebrow}
      title={copy.identity.security.title}
      description={copy.identity.security.description}
    >
      <form
        className="identity-form"
        ref={formRef}
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
          <label htmlFor="current-password">{copy.identity.common.currentPasswordLabel}</label>
          <input
            id="current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            required
            aria-invalid={Boolean(errors.currentPassword)}
            aria-describedby={errors.currentPassword ? "current-password-error" : undefined}
          />
          <FieldError id="current-password-error" message={errors.currentPassword} />
        </div>
        <div className="form-field">
          <label htmlFor="new-password">{copy.identity.common.newPasswordLabel}</label>
          <input
            id="new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            required
            aria-invalid={Boolean(errors.newPassword)}
            aria-describedby={`new-password-help${errors.newPassword ? " new-password-error" : ""}`}
          />
          <p className="field-help" id="new-password-help">
            {copy.identity.common.passwordHelp}
          </p>
          <FieldError id="new-password-error" message={errors.newPassword} />
        </div>
        <div className="form-field">
          <label htmlFor="security-confirmation">{copy.identity.common.confirmPasswordLabel}</label>
          <input
            id="security-confirmation"
            name="confirmation"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            required
            aria-invalid={Boolean(errors.confirmation)}
            aria-describedby={errors.confirmation ? "security-confirmation-error" : undefined}
          />
          <FieldError id="security-confirmation-error" message={errors.confirmation} />
        </div>
        <button className="primary-button" type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? copy.identity.security.submitting : copy.identity.security.submit}
        </button>
      </form>
      <Link className="text-link" to="/">
        {copy.identity.common.backToHome}
      </Link>
    </IdentityPanel>
  );
}
