import type {
  AdminAssistantRulesResponse,
  AssistantRulesActor,
  AssistantRulesRevision,
  PreviewAssistantRulesResponse,
  SessionResponse,
} from "@capstone/protocol";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import { copy } from "../copy";
import { assistantRulesQueryKeys } from "../identity/assistant-rules-api";
import { FieldError, FormMessage } from "../identity/form-feedback";
import {
  AdministrationApiError,
  administrationQueryKeys,
  administrationQueryScope,
  fetchAdminAssistantRules,
  fetchAdminAssistantRulesHistory,
  previewAdminAssistantRules,
  resetAdminAssistantRules,
  revertAdminAssistantRules,
  updateAdminAssistantRules,
} from "./api";
import { AdministrationError } from "./feedback";

type PreviewStatus = "idle" | "waiting" | "loading" | "ready" | "invalid" | "error";

function actorName(actor: AssistantRulesActor): string {
  return actor.kind === "system" ? actor.label : actor.displayName;
}

function previewFromCurrent(current: AdminAssistantRulesResponse): PreviewAssistantRulesResponse {
  return {
    normalizedWorkspaceText: current.workspaceText,
    effectivePrompt: current.effectivePrompt,
    estimate: current.estimate,
  };
}

function immediateCounts(text: string): {
  readonly codePoints: number;
  readonly utf8Bytes: number;
} {
  return {
    codePoints: [...text].length,
    utf8Bytes: new TextEncoder().encode(text).length,
  };
}

function invalidUnicodeOrControls(text: string): boolean {
  return (
    !text.isWellFormed() ||
    [...text].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      );
    })
  );
}

export function AssistantPage() {
  const session = useOutletContext<SessionResponse>();
  const scope = administrationQueryScope(session);
  const queryClient = useQueryClient();
  const currentKey = administrationQueryKeys.assistantRules(scope);
  const historyKey = administrationQueryKeys.assistantRulesHistory(scope);
  const [draft, setDraft] = useState<string>();
  const [preview, setPreview] = useState<PreviewAssistantRulesResponse>();
  const [previewForText, setPreviewForText] = useState<string>();
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle");
  const [previewError, setPreviewError] = useState<unknown>();
  const [success, setSuccess] = useState<string>();
  const [resetOpen, setResetOpen] = useState(false);
  const [revertRevision, setRevertRevision] = useState<AssistantRulesRevision>();
  const resetDialogRef = useRef<HTMLDialogElement>(null);
  const resetButtonRef = useRef<HTMLButtonElement>(null);
  const revertDialogRef = useRef<HTMLDialogElement>(null);
  const revertButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.title = copy.brand.pageTitle(copy.administration.assistant.title);
  }, []);

  const current = useQuery({
    queryKey: currentKey,
    queryFn: ({ signal }) => fetchAdminAssistantRules(signal),
  });
  const history = useInfiniteQuery({
    queryKey: historyKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchAdminAssistantRulesHistory(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  useEffect(() => {
    if (draft === undefined && current.data) {
      setDraft(current.data.workspaceText);
      setPreview(previewFromCurrent(current.data));
      setPreviewForText(current.data.workspaceText);
      setPreviewStatus("ready");
    }
  }, [current.data, draft]);

  const counts = useMemo(() => immediateCounts(draft ?? ""), [draft]);
  const localInvalid = Boolean(
    draft !== undefined &&
      current.data &&
      (invalidUnicodeOrControls(draft) ||
        counts.codePoints > current.data.limits.maximumCodePoints ||
        counts.utf8Bytes > current.data.limits.maximumUtf8Bytes),
  );

  useEffect(() => {
    if (draft === undefined || current.data === undefined) {
      return;
    }
    if (localInvalid) {
      setPreviewStatus("invalid");
      setPreviewError(undefined);
      return;
    }

    const controller = new AbortController();
    setPreviewStatus("waiting");
    setPreviewError(undefined);
    const timer = window.setTimeout(() => {
      setPreviewStatus("loading");
      void previewAdminAssistantRules({ workspaceText: draft }, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) {
            return;
          }
          setPreview(result);
          setPreviewForText(draft);
          setPreviewStatus("ready");
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          setPreviewError(error);
          setPreviewStatus(
            error instanceof AdministrationApiError &&
              (error.code === "BAD_REQUEST" || error.code === "PAYLOAD_TOO_LARGE")
              ? "invalid"
              : "error",
          );
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [current.data, draft, localInvalid]);

  useEffect(() => {
    const dialog = resetDialogRef.current;
    if (!dialog) {
      return;
    }
    if (resetOpen && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    } else if (!resetOpen && dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [resetOpen]);

  useEffect(() => {
    const dialog = revertDialogRef.current;
    if (!dialog) {
      return;
    }
    if (revertRevision && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    } else if (!revertRevision && dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [revertRevision]);

  function closeResetDialog(): void {
    const dialog = resetDialogRef.current;
    if (dialog && typeof dialog.close === "function") {
      dialog.close();
      return;
    }
    dialog?.removeAttribute("open");
    setResetOpen(false);
    resetButtonRef.current?.focus();
  }

  function closeRevertDialog(): void {
    const dialog = revertDialogRef.current;
    if (dialog && typeof dialog.close === "function") {
      dialog.close();
      return;
    }
    dialog?.removeAttribute("open");
    setRevertRevision(undefined);
    revertButtonRef.current?.focus();
  }

  async function refreshAfterStale(error: unknown): Promise<void> {
    if (error instanceof AdministrationApiError && error.code === "ASSISTANT_RULES_CHANGED") {
      await current.refetch();
    }
  }

  async function adoptServerState(
    updated: AdminAssistantRulesResponse,
    message: string,
  ): Promise<void> {
    queryClient.setQueryData(currentKey, updated);
    setDraft(updated.workspaceText);
    setPreview(previewFromCurrent(updated));
    setPreviewForText(updated.workspaceText);
    setPreviewStatus("ready");
    setPreviewError(undefined);
    setSuccess(message);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: historyKey }),
      queryClient.invalidateQueries({ queryKey: assistantRulesQueryKeys.all }),
    ]);
  }

  const save = useMutation({
    mutationFn: () => {
      if (!current.data || draft === undefined) {
        throw new Error("The assistant rules form is incomplete.");
      }
      return updateAdminAssistantRules({
        observedRevision: current.data.revision,
        workspaceText: draft,
      });
    },
    onSuccess: (updated) => adoptServerState(updated, copy.administration.assistant.saved),
    onError: refreshAfterStale,
  });
  const reset = useMutation({
    mutationFn: () => {
      if (!current.data) {
        throw new Error("The assistant rules form is incomplete.");
      }
      return resetAdminAssistantRules({ observedRevision: current.data.revision });
    },
    onSuccess: async (updated) => {
      closeResetDialog();
      await adoptServerState(updated, copy.administration.assistant.resetSuccess);
    },
    onError: refreshAfterStale,
  });
  const revert = useMutation({
    mutationFn: (revision: number) => {
      if (!current.data) {
        throw new Error("The assistant rules form is incomplete.");
      }
      return revertAdminAssistantRules(revision, {
        observedRevision: current.data.revision,
      });
    },
    onSuccess: async (updated) => {
      closeRevertDialog();
      await adoptServerState(updated, copy.administration.assistant.reverted);
    },
    onError: refreshAfterStale,
  });

  const mutating = save.isPending || reset.isPending || revert.isPending;
  const previewCurrent =
    previewStatus === "ready" && preview !== undefined && previewForText === draft;
  const unchanged =
    previewCurrent && current.data !== undefined
      ? preview.normalizedWorkspaceText === current.data.workspaceText
      : false;
  const saveDisabled = mutating || localInvalid || !previewCurrent || unchanged;
  // Mirrors the previous inline branches exactly: the field is invalid only when
  // localInvalid or the preview says so, and the unicode message wins when both apply.
  const ruleError =
    !localInvalid && previewStatus !== "invalid"
      ? undefined
      : draft !== undefined && invalidUnicodeOrControls(draft)
        ? copy.administration.assistant.invalidText
        : copy.administration.assistant.limitExceeded;
  const mutationError = save.error ?? reset.error ?? revert.error;
  const confirmed = previewCurrent ? preview.estimate : undefined;
  const historyItems = history.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="admin-page" aria-labelledby="assistant-title">
      <header className="admin-page-heading">
        <p className="identity-eyebrow">{copy.administration.navigation.label}</p>
        <h1 id="assistant-title">{copy.administration.assistant.title}</h1>
        <p>{copy.administration.assistant.description}</p>
      </header>
      <FormMessage kind="success" message={success} />

      <section
        className="admin-card assistant-editor-card"
        aria-labelledby="assistant-editor-title"
      >
        <div className="admin-card-heading">
          <div>
            <h2 id="assistant-editor-title">{copy.administration.assistant.editorTitle}</h2>
            {current.data ? (
              <p className="admin-revision-meta">
                {copy.administration.assistant.updatedBy(
                  actorName(current.data.actor),
                  new Date(current.data.updatedAt).toLocaleString("es-EC"),
                )}{" "}
                · {copy.administration.assistant.revision(current.data.revision)}
              </p>
            ) : null}
          </div>
        </div>
        {current.isError ? (
          <AdministrationError error={current.error} />
        ) : current.isPending || draft === undefined || current.data === undefined ? (
          <p role="status">{copy.administration.common.loading}</p>
        ) : (
          <form
            className="assistant-rules-form"
            aria-busy={mutating}
            onSubmit={(event) => {
              event.preventDefault();
              setSuccess(undefined);
              save.reset();
              reset.reset();
              revert.reset();
              if (!saveDisabled) {
                save.mutate();
              }
            }}
          >
            <div className="form-field">
              <label htmlFor="assistant-workspace-text">
                {copy.administration.assistant.label}
              </label>
              <textarea
                id="assistant-workspace-text"
                value={draft}
                aria-invalid={ruleError !== undefined}
                aria-describedby={
                  ruleError === undefined
                    ? "assistant-rules-help assistant-rules-preview-status"
                    : "assistant-rules-help assistant-rules-preview-status assistant-rules-error"
                }
                onChange={(event) => {
                  setDraft(event.target.value);
                  setSuccess(undefined);
                  save.reset();
                }}
              />
              <p className="field-help" id="assistant-rules-help">
                {copy.administration.assistant.help}
              </p>
              <FieldError id="assistant-rules-error" message={ruleError} />
            </div>

            <div className="assistant-count-grid">
              <section aria-labelledby="immediate-count-title">
                <h3 id="immediate-count-title">{copy.administration.assistant.immediate}</h3>
                <p>
                  {copy.administration.assistant.count(
                    counts.codePoints,
                    current.data.limits.maximumCodePoints,
                    Math.max(0, current.data.limits.maximumCodePoints - counts.codePoints),
                    copy.administration.assistant.codePoints,
                  )}
                </p>
                <p>
                  {copy.administration.assistant.count(
                    counts.utf8Bytes,
                    current.data.limits.maximumUtf8Bytes,
                    Math.max(0, current.data.limits.maximumUtf8Bytes - counts.utf8Bytes),
                    copy.administration.assistant.utf8Bytes,
                  )}
                </p>
              </section>
              <section aria-labelledby="confirmed-count-title">
                <h3 id="confirmed-count-title">{copy.administration.assistant.confirmed}</h3>
                {confirmed ? (
                  <>
                    <p>
                      {copy.administration.assistant.count(
                        confirmed.counts.codePoints,
                        current.data.limits.maximumCodePoints,
                        current.data.limits.maximumCodePoints - confirmed.counts.codePoints,
                        copy.administration.assistant.codePoints,
                      )}
                    </p>
                    <p>
                      {copy.administration.assistant.count(
                        confirmed.counts.utf8Bytes,
                        current.data.limits.maximumUtf8Bytes,
                        current.data.limits.maximumUtf8Bytes - confirmed.counts.utf8Bytes,
                        copy.administration.assistant.utf8Bytes,
                      )}
                    </p>
                    <p>
                      {copy.administration.assistant.approximateTokens(
                        confirmed.counts.approximateInputTokens,
                      )}
                    </p>
                    <p>
                      {confirmed.balancedMaximumResponseCostPercent === null
                        ? copy.administration.assistant.costUnavailable
                        : copy.administration.assistant.balancedCost(
                            confirmed.balancedMaximumResponseCostPercent,
                          )}
                    </p>
                    <p className="field-help">{copy.administration.assistant.estimateCaveat}</p>
                  </>
                ) : null}
              </section>
            </div>
            <p
              className="assistant-preview-status"
              id="assistant-rules-preview-status"
              role="status"
              aria-live="polite"
            >
              {previewStatus === "waiting"
                ? copy.administration.assistant.previewWaiting
                : previewStatus === "loading"
                  ? copy.administration.assistant.previewLoading
                  : previewStatus === "ready"
                    ? copy.administration.assistant.previewReady
                    : previewStatus === "error"
                      ? copy.administration.assistant.previewError
                      : ""}
            </p>
            {previewError && previewStatus === "error" ? (
              <AdministrationError error={previewError} />
            ) : null}

            <section className="assistant-preview" aria-labelledby="assistant-preview-title">
              <h3 id="assistant-preview-title">{copy.administration.assistant.previewTitle}</h3>
              <p className="field-help">{copy.administration.assistant.previewHelp}</p>
              <pre>{previewCurrent ? preview.effectivePrompt : ""}</pre>
            </section>

            <section className="assistant-disclosure" aria-labelledby="assistant-disclosure-title">
              <h3 id="assistant-disclosure-title">
                {copy.administration.assistant.disclosureTitle}
              </h3>
              <ul>
                <li>{copy.administration.assistant.disclosures.members}</li>
                <li>{copy.administration.assistant.disclosures.provider}</li>
                <li>{copy.administration.assistant.disclosures.history}</li>
              </ul>
            </section>

            <div className="assistant-form-actions">
              <button className="primary-button" type="submit" disabled={saveDisabled}>
                {save.isPending
                  ? copy.administration.common.saving
                  : copy.administration.common.save}
              </button>
              <button
                className="secondary-button"
                ref={resetButtonRef}
                type="button"
                disabled={mutating}
                onClick={() => {
                  setSuccess(undefined);
                  setResetOpen(true);
                }}
              >
                {reset.isPending
                  ? copy.administration.assistant.resetting
                  : copy.administration.assistant.reset}
              </button>
            </div>
            {mutationError ? <AdministrationError error={mutationError} /> : null}
          </form>
        )}
      </section>

      <section className="admin-card" aria-labelledby="assistant-history-title">
        <h2 id="assistant-history-title">{copy.administration.assistant.historyTitle}</h2>
        <p className="admin-card-description">{copy.administration.assistant.historyDescription}</p>
        {history.isPending ? (
          <p role="status">{copy.administration.common.loading}</p>
        ) : history.isError ? (
          <AdministrationError error={history.error} />
        ) : historyItems.length === 0 ? (
          <p>{copy.administration.assistant.historyEmpty}</p>
        ) : (
          <ol className="admin-revision-list">
            {historyItems.map((item) => (
              <li key={item.revision}>
                <article className="admin-revision">
                  <header>
                    <div>
                      <h3>{copy.administration.assistant.revision(item.revision)}</h3>
                      <p>
                        {copy.administration.assistant.updatedBy(
                          actorName(item.actor),
                          new Date(item.createdAt).toLocaleString("es-EC"),
                        )}
                      </p>
                      <p>{copy.administration.assistant.changeKinds[item.changeKind]}</p>
                      {item.revertedFromRevision ? (
                        <p>
                          {copy.administration.assistant.revertedFrom(item.revertedFromRevision)}
                        </p>
                      ) : null}
                    </div>
                    {item.revision === current.data?.revision ? (
                      <span className="admin-current-badge">
                        {copy.administration.assistant.currentRevision}
                      </span>
                    ) : (
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        disabled={mutating}
                        aria-label={`${copy.administration.common.revert}: ${copy.administration.assistant.revision(item.revision)}`}
                        onClick={(event) => {
                          setSuccess(undefined);
                          revertButtonRef.current = event.currentTarget;
                          setRevertRevision(item);
                        }}
                      >
                        {copy.administration.common.revert}
                      </button>
                    )}
                  </header>
                  <pre>{item.workspaceText || copy.administration.assistant.emptyText}</pre>
                </article>
              </li>
            ))}
          </ol>
        )}
        {history.hasNextPage ? (
          <button
            className="text-button"
            type="button"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage
              ? copy.administration.common.loadingMore
              : copy.administration.common.loadMore}
          </button>
        ) : null}
      </section>

      <dialog
        className="confirmation-dialog"
        ref={resetDialogRef}
        aria-labelledby="assistant-reset-title"
        onClose={() => {
          setResetOpen(false);
          resetButtonRef.current?.focus();
        }}
      >
        <h2 id="assistant-reset-title">{copy.administration.assistant.resetTitle}</h2>
        <p>{copy.administration.assistant.resetNotice}</p>
        <pre className="assistant-reset-target">{copy.administration.assistant.resetTarget}</pre>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={reset.isPending}
            onClick={closeResetDialog}
          >
            {copy.administration.common.cancel}
          </button>
          <button
            className="danger-button"
            type="button"
            disabled={reset.isPending}
            onClick={() => reset.mutate()}
          >
            {reset.isPending
              ? copy.administration.assistant.resetting
              : copy.administration.assistant.confirmReset}
          </button>
        </div>
        {reset.isError ? <AdministrationError error={reset.error} /> : null}
      </dialog>

      <dialog
        className="confirmation-dialog"
        ref={revertDialogRef}
        aria-labelledby="assistant-revert-title"
        onClose={() => {
          setRevertRevision(undefined);
          revertButtonRef.current?.focus();
        }}
      >
        <h2 id="assistant-revert-title">{copy.administration.assistant.revertTitle}</h2>
        <p>
          {revertRevision
            ? copy.administration.assistant.revertNotice(revertRevision.revision)
            : ""}
        </p>
        {revertRevision ? (
          <pre className="assistant-reset-target">
            {revertRevision.workspaceText || copy.administration.assistant.emptyText}
          </pre>
        ) : null}
        <p>{copy.administration.assistant.disclosures.history}</p>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={revert.isPending}
            onClick={closeRevertDialog}
          >
            {copy.administration.common.cancel}
          </button>
          <button
            className="danger-button"
            type="button"
            disabled={revert.isPending}
            onClick={() => {
              if (revertRevision) {
                revert.mutate(revertRevision.revision);
              }
            }}
          >
            {revert.isPending
              ? copy.administration.common.reverting
              : copy.administration.common.revert}
          </button>
        </div>
        {revert.isError ? <AdministrationError error={revert.error} /> : null}
      </dialog>
    </section>
  );
}
