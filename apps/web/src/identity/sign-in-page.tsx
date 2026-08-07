import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";

import { copy } from "../copy";
import { signIn } from "./auth-actions";
import { FieldError, FormMessage, useFeedbackAttempt } from "./form-feedback";
import { IdentityPanel } from "./identity-panel";
import { emailError, passwordError } from "./validation";

type SignInErrors = {
  email: string | undefined;
  password: string | undefined;
};

export function SignInPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [feedbackAttempt, beginFeedbackAttempt] = useFeedbackAttempt();
  const [errors, setErrors] = useState<SignInErrors>({ email: undefined, password: undefined });
  const mutation = useMutation({
    mutationFn: signIn,
    onSuccess: async () => {
      await queryClient.cancelQueries();
      queryClient.clear();
      navigate("/", { replace: true });
    },
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    beginFeedbackAttempt();
    mutation.reset();

    const form = event.currentTarget;
    const email = form.elements.namedItem("email") as HTMLInputElement;
    const password = form.elements.namedItem("password") as HTMLInputElement;
    const nextErrors: SignInErrors = {
      email: emailError(email),
      password: passwordError(password.value),
    };

    setErrors(nextErrors);

    if (nextErrors.email || nextErrors.password) {
      return;
    }

    mutation.mutate({ email: email.value.trim(), password: password.value });
  }

  const feedback = Object.values(errors).some(Boolean)
    ? copy.identity.common.validationSummary
    : mutation.isError
      ? copy.identity.signIn.error
      : undefined;

  return (
    <IdentityPanel
      eyebrow={copy.identity.signIn.eyebrow}
      title={copy.identity.signIn.title}
      description={copy.identity.signIn.description}
    >
      <form
        className="identity-form"
        onSubmit={handleSubmit}
        noValidate
        aria-busy={mutation.isPending}
      >
        <FormMessage focusKey={feedbackAttempt} kind="error" message={feedback} />

        <div className="form-field">
          <label htmlFor="sign-in-email">{copy.identity.common.emailLabel}</label>
          <input
            id="sign-in-email"
            name="email"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "sign-in-email-error" : undefined}
          />
          <FieldError id="sign-in-email-error" message={errors.email} />
        </div>

        <div className="form-field">
          <div className="field-label-row">
            <label htmlFor="sign-in-password">{copy.identity.common.passwordLabel}</label>
            <Link to="/forgot-password">{copy.identity.signIn.forgotPassword}</Link>
          </div>
          <input
            id="sign-in-password"
            name="password"
            type="password"
            autoComplete="current-password"
            minLength={12}
            maxLength={128}
            required
            aria-invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? "sign-in-password-error" : undefined}
          />
          <FieldError id="sign-in-password-error" message={errors.password} />
        </div>

        <button className="primary-button" type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? copy.identity.signIn.submitting : copy.identity.signIn.submit}
        </button>
      </form>

      <p className="identity-alternate">
        {copy.identity.signIn.signUpPrompt}{" "}
        <Link to="/sign-up">{copy.identity.signIn.signUpLink}</Link>
      </p>
    </IdentityPanel>
  );
}
