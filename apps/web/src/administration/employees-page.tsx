import type { AdminEmployee, AdminEmployeeRole, SessionResponse } from "@capstone/protocol";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router";

import { sessionQueryKey } from "../api/session";
import { copy } from "../copy";
import { FieldError, FormMessage, useFeedbackAttempt } from "../identity/form-feedback";
import { emailError } from "../identity/validation";
import {
  AdministrationApiError,
  administrationQueryKeys,
  administrationQueryScope,
  approveAdminEmployee,
  deactivateAdminEmployee,
  fetchAdminEmployees,
  resendAdminInvitation,
  revokeAdminEmployeeSessions,
  updateAdminEmployeeSoftBudget,
} from "./api";
import { AdministrationError } from "./feedback";
import { formatAdminUsd } from "./formatting";
import { usdError } from "./validation";

function statusLabel(status: AdminEmployee["status"]): string {
  return copy.administration.employees[status];
}

function roleLabel(role: AdminEmployeeRole): string {
  return copy.administration.employees[role];
}

function SoftBudgetControl({
  employee,
  onChanged,
}: {
  readonly employee: AdminEmployee;
  readonly onChanged: () => Promise<void>;
}) {
  const [value, setValue] = useState(employee.monthlySoftBudgetUsd ?? "");
  const [validationError, setValidationError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: (monthlySoftBudgetUsd: string | null) =>
      updateAdminEmployeeSoftBudget(employee.approvalId, {
        monthlySoftBudgetUsd,
      }),
    onSuccess: async (updated) => {
      setValue(updated.monthlySoftBudgetUsd ?? "");
      setSaved(true);
      await onChanged();
    },
  });
  useEffect(() => {
    setValue(employee.monthlySoftBudgetUsd ?? "");
    setValidationError(undefined);
  }, [employee.monthlySoftBudgetUsd]);

  function saveBudget(monthlySoftBudgetUsd: string | null): void {
    const error = monthlySoftBudgetUsd === null ? undefined : usdError(monthlySoftBudgetUsd, true);
    setValidationError(error);
    setSaved(false);
    mutation.reset();
    if (!error) {
      mutation.mutate(monthlySoftBudgetUsd);
    }
  }

  const fieldId = `soft-budget-${employee.approvalId}`;
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;

  return (
    <div className="admin-budget-control">
      <label className="visually-hidden" htmlFor={fieldId}>
        {copy.administration.employees.softBudget}: {employee.email}
      </label>
      <input
        id={fieldId}
        inputMode="decimal"
        value={value}
        disabled={mutation.isPending}
        aria-invalid={Boolean(validationError)}
        aria-describedby={`${helpId}${validationError ? ` ${errorId}` : ""}`}
        onChange={(event) => {
          setValue(event.target.value);
          setSaved(false);
          setValidationError(undefined);
        }}
      />
      <div className="admin-budget-actions">
        <button
          className="secondary-button compact-button"
          type="button"
          disabled={mutation.isPending}
          onClick={() => saveBudget(value.trim() === "" ? null : value.trim())}
        >
          {mutation.isPending ? copy.administration.common.saving : copy.administration.common.save}
        </button>
        {employee.monthlySoftBudgetUsd !== null || value.trim() !== "" ? (
          <button
            className="text-button"
            type="button"
            disabled={mutation.isPending}
            onClick={() => saveBudget(null)}
          >
            {copy.administration.employees.clearBudget}
          </button>
        ) : null}
      </div>
      <p className="field-help" id={helpId}>
        {copy.administration.employees.budgetHelp}
      </p>
      <FieldError id={errorId} message={validationError} />
      {saved ? (
        <p className="admin-inline-success" role="status">
          {copy.administration.employees.budgetSaved}
        </p>
      ) : null}
      {mutation.isError ? <AdministrationError error={mutation.error} /> : null}
    </div>
  );
}

export function EmployeesPage() {
  const session = useOutletContext<SessionResponse>();
  const queryClient = useQueryClient();
  const scope = administrationQueryScope(session);
  const employeesKey = administrationQueryKeys.employees(scope);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminEmployeeRole>("member");
  const [success, setSuccess] = useState<string>();
  const [emailValidation, setEmailValidation] = useState<string>();
  const [feedbackAttempt, beginFeedbackAttempt] = useFeedbackAttempt();
  const [selectedForDeactivation, setSelectedForDeactivation] = useState<AdminEmployee>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const deactivationButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.title = copy.brand.pageTitle(copy.administration.employees.title);
  }, []);

  const employees = useInfiniteQuery({
    queryKey: employeesKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchAdminEmployees(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: employeesKey });
  };
  const invalidateBudget = async (): Promise<void> => {
    await Promise.all([
      invalidate(),
      queryClient.invalidateQueries({ queryKey: administrationQueryKeys.usage(scope) }),
    ]);
  };
  const approval = useMutation({
    mutationFn: () => approveAdminEmployee({ email: email.trim(), role }),
    onSuccess: async () => {
      setEmail("");
      setEmailValidation(undefined);
      setSuccess(copy.administration.employees.invitationSent);
      await invalidate();
    },
    onError: async (error) => {
      if (error instanceof AdministrationApiError && error.code === "INVITATION_DELIVERY_FAILED") {
        await invalidate();
      }
    },
  });
  const resend = useMutation({
    mutationFn: (approvalId: string) => resendAdminInvitation(approvalId),
    onSuccess: async () => {
      setSuccess(copy.administration.employees.invitationSent);
      await invalidate();
    },
  });
  const revoke = useMutation({
    mutationFn: (employee: AdminEmployee) => revokeAdminEmployeeSessions(employee.approvalId),
    onSuccess: async (_, employee) => {
      setSuccess(copy.administration.employees.sessionsRevoked);
      if (employee.userId === session.employee.id) {
        await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      }
    },
  });
  const deactivate = useMutation({
    mutationFn: (approvalId: string) => deactivateAdminEmployee(approvalId),
    onSuccess: async () => {
      closeDeactivationDialog();
      await invalidate();
    },
    onError: async (error) => {
      if (
        error instanceof AdministrationApiError &&
        error.code === "EMPLOYEE_DEACTIVATION_INCOMPLETE"
      ) {
        closeDeactivationDialog();
        await invalidate();
      }
    },
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (selectedForDeactivation && dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }
  }, [selectedForDeactivation]);

  function closeDeactivationDialog(): void {
    const dialog = dialogRef.current;
    if (dialog && typeof dialog.close === "function") {
      dialog.close();
      return;
    }
    dialog?.removeAttribute("open");
    setSelectedForDeactivation(undefined);
    deactivationButtonRef.current?.focus();
  }

  function resetActionFeedback(): void {
    setSuccess(undefined);
    resend.reset();
    revoke.reset();
    deactivate.reset();
  }

  const rows = employees.data?.pages.flatMap((page) => page.items) ?? [];
  const actionError = resend.error ?? revoke.error ?? deactivate.error;
  const actionPending = resend.isPending || revoke.isPending || deactivate.isPending;

  return (
    <section className="admin-page" aria-labelledby="employees-title">
      <header className="admin-page-heading">
        <p className="identity-eyebrow">{copy.administration.navigation.label}</p>
        <h1 id="employees-title">{copy.administration.employees.title}</h1>
        <p>{copy.administration.employees.description}</p>
      </header>

      <section className="admin-card" aria-labelledby="approve-title">
        <h2 id="approve-title">{copy.administration.employees.approveTitle}</h2>
        <form
          className="admin-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            beginFeedbackAttempt();
            approval.reset();
            setSuccess(undefined);
            const emailInput = event.currentTarget.elements.namedItem(
              "approvalEmail",
            ) as HTMLInputElement;
            const error = emailError(emailInput);
            setEmailValidation(error);
            if (error) {
              return;
            }
            approval.mutate();
          }}
          noValidate
          aria-busy={approval.isPending}
        >
          <div className="form-field">
            <label htmlFor="approval-email">{copy.administration.employees.email}</label>
            <input
              id="approval-email"
              name="approvalEmail"
              type="email"
              required
              autoComplete="email"
              value={email}
              aria-invalid={Boolean(emailValidation)}
              aria-describedby={emailValidation ? "approval-email-error" : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailValidation(undefined);
              }}
            />
            <FieldError id="approval-email-error" message={emailValidation} />
          </div>
          <div className="form-field">
            <label htmlFor="approval-role">{copy.administration.employees.role}</label>
            <select
              id="approval-role"
              value={role}
              onChange={(event) => setRole(event.target.value as AdminEmployeeRole)}
            >
              <option value="member">{copy.administration.employees.member}</option>
              <option value="admin">{copy.administration.employees.admin}</option>
            </select>
          </div>
          <button className="primary-button" type="submit" disabled={approval.isPending}>
            {approval.isPending
              ? copy.administration.employees.approving
              : copy.administration.employees.approve}
          </button>
        </form>
        <FormMessage
          focusKey={feedbackAttempt}
          kind="error"
          message={emailValidation ? copy.identity.common.validationSummary : undefined}
        />
        {approval.isError ? <AdministrationError error={approval.error} /> : null}
      </section>

      <FormMessage kind="success" message={success} />
      {actionError ? <AdministrationError error={actionError} /> : null}

      <section
        className="admin-table-scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The wide semantic table must be keyboard-scrollable on narrow screens.
        tabIndex={0}
        aria-label={copy.administration.employees.title}
      >
        <table className="admin-table">
          <caption>{copy.administration.employees.title}</caption>
          <thead>
            <tr>
              <th scope="col">{copy.administration.employees.email}</th>
              <th scope="col">{copy.administration.employees.name}</th>
              <th scope="col">{copy.administration.employees.role}</th>
              <th scope="col">{copy.administration.employees.status}</th>
              <th scope="col">{copy.administration.employees.softBudget}</th>
              <th scope="col">{copy.administration.employees.actions}</th>
            </tr>
          </thead>
          <tbody>
            {employees.isPending ? (
              <tr>
                <td colSpan={6} role="status">
                  {copy.administration.common.loading}
                </td>
              </tr>
            ) : employees.isError ? (
              <tr>
                <td colSpan={6}>
                  <AdministrationError error={employees.error} />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6}>{copy.administration.employees.empty}</td>
              </tr>
            ) : (
              rows.map((employee) => (
                <tr key={employee.approvalId}>
                  <th scope="row">{employee.email}</th>
                  <td>{employee.name ?? "—"}</td>
                  <td>{roleLabel(employee.role)}</td>
                  <td>{statusLabel(employee.status)}</td>
                  <td>
                    {employee.status === "active" ? (
                      <SoftBudgetControl employee={employee} onChanged={invalidateBudget} />
                    ) : employee.monthlySoftBudgetUsd === null ? (
                      "—"
                    ) : (
                      formatAdminUsd(employee.monthlySoftBudgetUsd)
                    )}
                  </td>
                  <td>
                    <div className="admin-row-actions">
                      {employee.status === "pending" ? (
                        <button
                          className="text-button"
                          type="button"
                          disabled={actionPending}
                          onClick={() => {
                            resetActionFeedback();
                            resend.mutate(employee.approvalId);
                          }}
                        >
                          {copy.administration.employees.resend}
                        </button>
                      ) : null}
                      {employee.status === "active" ? (
                        <button
                          className="text-button"
                          type="button"
                          disabled={actionPending}
                          onClick={() => {
                            resetActionFeedback();
                            revoke.mutate(employee);
                          }}
                        >
                          {copy.administration.employees.revokeSessions}
                        </button>
                      ) : null}
                      {employee.status !== "deactivated" &&
                      employee.userId !== session.employee.id ? (
                        <button
                          className="text-button admin-danger-link"
                          ref={
                            selectedForDeactivation?.approvalId === employee.approvalId
                              ? deactivationButtonRef
                              : undefined
                          }
                          type="button"
                          disabled={actionPending}
                          onClick={(event) => {
                            resetActionFeedback();
                            deactivationButtonRef.current = event.currentTarget;
                            setSelectedForDeactivation(employee);
                          }}
                        >
                          {copy.administration.employees.deactivate}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      {employees.hasNextPage ? (
        <button
          className="secondary-button"
          type="button"
          disabled={employees.isFetchingNextPage}
          onClick={() => void employees.fetchNextPage()}
        >
          {employees.isFetchingNextPage
            ? copy.administration.common.loadingMore
            : copy.administration.common.loadMore}
        </button>
      ) : null}

      <dialog
        className="confirmation-dialog"
        ref={dialogRef}
        aria-labelledby="deactivate-title"
        onClose={() => {
          setSelectedForDeactivation(undefined);
          deactivationButtonRef.current?.focus();
        }}
      >
        <h2 id="deactivate-title">{copy.administration.employees.deactivateTitle}</h2>
        <p>
          {selectedForDeactivation
            ? copy.administration.employees.deactivateNotice(selectedForDeactivation.email)
            : ""}
        </p>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={closeDeactivationDialog}>
            {copy.administration.common.cancel}
          </button>
          <button
            className="danger-button"
            type="button"
            disabled={deactivate.isPending}
            onClick={() => {
              if (selectedForDeactivation) {
                deactivate.mutate(selectedForDeactivation.approvalId);
              }
            }}
          >
            {copy.administration.employees.confirmDeactivate}
          </button>
        </div>
      </dialog>
    </section>
  );
}
