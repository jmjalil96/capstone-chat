import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";

import { sessionQueryKey } from "../api/session";
import { copy } from "../copy";
import { signUp } from "./auth-actions";
import { FieldError, FormMessage, useFeedbackAttempt } from "./form-feedback";
import { IdentityPanel } from "./identity-panel";
import {
  confirmationError,
  emailError,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordError,
  requiredError,
} from "./validation";

type SignUpErrors = {
  name: string | undefined;
  email: string | undefined;
  password: string | undefined;
  confirmation: string | undefined;
};

export function SignUpPage() {
  const queryClient = useQueryClient();
  const [feedbackAttempt, beginFeedbackAttempt] = useFeedbackAttempt();
  const [errors, setErrors] = useState<SignUpErrors>({
    name: undefined,
    email: undefined,
    password: undefined,
    confirmation: undefined,
  });
  const mutation = useMutation({
    mutationFn: signUp,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    beginFeedbackAttempt();
    mutation.reset();

    const form = event.currentTarget;
    const name = form.elements.namedItem("name") as HTMLInputElement;
    const email = form.elements.namedItem("email") as HTMLInputElement;
    const password = form.elements.namedItem("password") as HTMLInputElement;
    const confirmation = form.elements.namedItem("confirmation") as HTMLInputElement;
    const nextErrors: SignUpErrors = {
      name: requiredError(name.value),
      email: emailError(email),
      password: passwordError(password.value),
      confirmation: confirmationError(password.value, confirmation.value),
    };

    setErrors(nextErrors);

    if (Object.values(nextErrors).some(Boolean)) {
      return;
    }

    mutation.mutate({
      name: name.value.trim(),
      email: email.value.trim(),
      password: password.value,
    });
  }

  if (mutation.isSuccess) {
    return (
      <IdentityPanel
        eyebrow={copy.identity.signUp.eyebrow}
        title={copy.identity.signUp.successTitle}
        description={copy.identity.signUp.success}
      >
        <FormMessage kind="success" message={copy.identity.signUp.success} />
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
      eyebrow={copy.identity.signUp.eyebrow}
      title={copy.identity.signUp.title}
      description={copy.identity.signUp.description}
    >
      <form
        className="identity-form"
        onSubmit={handleSubmit}
        noValidate
        aria-busy={mutation.isPending}
      >
        <FormMessage focusKey={feedbackAttempt} kind="error" message={feedback} />

        <div className="form-field">
          <label htmlFor="sign-up-name">{copy.identity.common.nameLabel}</label>
          <input
            id="sign-up-name"
            name="name"
            type="text"
            autoComplete="name"
            required
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? "sign-up-name-error" : undefined}
          />
          <FieldError id="sign-up-name-error" message={errors.name} />
        </div>

        <div className="form-field">
          <label htmlFor="sign-up-email">{copy.identity.common.emailLabel}</label>
          <input
            id="sign-up-email"
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "sign-up-email-error" : undefined}
          />
          <FieldError id="sign-up-email-error" message={errors.email} />
        </div>

        <div className="form-field">
          <label htmlFor="sign-up-password">{copy.identity.common.passwordLabel}</label>
          <input
            id="sign-up-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            required
            aria-invalid={Boolean(errors.password)}
            aria-describedby={`sign-up-password-help${errors.password ? " sign-up-password-error" : ""}`}
          />
          <p className="field-help" id="sign-up-password-help">
            {copy.identity.common.passwordHelp}
          </p>
          <FieldError id="sign-up-password-error" message={errors.password} />
        </div>

        <div className="form-field">
          <label htmlFor="sign-up-confirmation">{copy.identity.common.confirmPasswordLabel}</label>
          <input
            id="sign-up-confirmation"
            name="confirmation"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            required
            aria-invalid={Boolean(errors.confirmation)}
            aria-describedby={errors.confirmation ? "sign-up-confirmation-error" : undefined}
          />
          <FieldError id="sign-up-confirmation-error" message={errors.confirmation} />
        </div>

        <button className="primary-button" type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? copy.identity.signUp.submitting : copy.identity.signUp.submit}
        </button>
      </form>

      <p className="identity-alternate">
        {copy.identity.signUp.signInPrompt}{" "}
        <Link to="/sign-in">{copy.identity.signUp.signInLink}</Link>
      </p>
    </IdentityPanel>
  );
}
