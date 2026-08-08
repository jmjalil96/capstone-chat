import type {
  AdminModelCatalogItem,
  AdminModelPolicyResponse,
  AdminUpdateModelPolicyRequest,
  GenerationModelTier,
  SessionResponse,
} from "@capstone/protocol";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router";

import { conversationQueryKeys } from "../conversations/api";
import { copy } from "../copy";
import { FieldError, FormMessage, useFeedbackAttempt } from "../identity/form-feedback";
import {
  AdministrationApiError,
  addAdminCatalogModel,
  administrationQueryKeys,
  administrationQueryScope,
  fetchAdminCatalog,
  fetchAdminPolicy,
  refreshAdminCatalog,
  updateAdminPolicy,
} from "./api";
import { AdministrationError } from "./feedback";
import { modelIdError, positiveIntegerError, usdError } from "./validation";

const tiers = ["fast", "balanced", "pro"] as const;

function tierName(tier: GenerationModelTier): string {
  return copy.conversations.modelTiers.tiers[tier].name;
}

function policyInput(policy: AdminModelPolicyResponse): AdminUpdateModelPolicyRequest {
  return {
    defaultTier: policy.defaultTier,
    monthlyBudgetUsd: policy.monthlyBudgetUsd,
    observedRevision: policy.revision,
    tiers: tiers.map((tier) => {
      const configured = policy.tiers.find((candidate) => candidate.tier === tier);
      if (!configured) {
        throw new Error("The administration policy is incomplete.");
      }
      return {
        catalogId: configured.catalogId,
        enabled: configured.enabled,
        maximumOutputTokens: configured.maximumOutputTokens,
        tier,
      };
    }) as AdminUpdateModelPolicyRequest["tiers"],
  };
}

interface PolicyValidation {
  readonly budget: string | undefined;
  readonly output: Record<GenerationModelTier, string | undefined>;
  readonly policy: string | undefined;
}

function emptyPolicyValidation(): PolicyValidation {
  return {
    budget: undefined,
    output: { balanced: undefined, fast: undefined, pro: undefined },
    policy: undefined,
  };
}

function validatePolicy(input: AdminUpdateModelPolicyRequest): PolicyValidation {
  const enabled = input.tiers.filter((tier) => tier.enabled);
  const defaultTier = input.tiers.find((tier) => tier.tier === input.defaultTier);
  const output = emptyPolicyValidation().output;
  for (const tier of input.tiers) {
    output[tier.tier] = positiveIntegerError(tier.maximumOutputTokens);
  }
  return {
    budget: usdError(input.monthlyBudgetUsd),
    output,
    policy:
      enabled.length === 0 || !defaultTier?.enabled
        ? copy.administration.models.policyInvalid
        : undefined,
  };
}

function hasPolicyError(validation: PolicyValidation): boolean {
  return Boolean(
    validation.budget || validation.policy || Object.values(validation.output).some(Boolean),
  );
}

const catalogIntegerFormatter = new Intl.NumberFormat("es-EC", { maximumFractionDigits: 0 });

export function ModelsPage() {
  const session = useOutletContext<SessionResponse>();
  const scope = administrationQueryScope(session);
  const queryClient = useQueryClient();
  const policyKey = administrationQueryKeys.policy(scope);
  const catalogKey = administrationQueryKeys.catalog(scope);
  const [form, setForm] = useState<AdminUpdateModelPolicyRequest>();
  const [modelId, setModelId] = useState("");
  const [success, setSuccess] = useState<string>();
  const [modelIdValidation, setModelIdValidation] = useState<string>();
  const [policyValidation, setPolicyValidation] = useState<PolicyValidation>(emptyPolicyValidation);
  const [feedbackAttempt, beginFeedbackAttempt] = useFeedbackAttempt();
  const refreshControllerRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    document.title = copy.brand.pageTitle(copy.administration.models.title);
  }, []);

  const policy = useQuery({
    queryKey: policyKey,
    queryFn: ({ signal }) => fetchAdminPolicy(signal),
  });
  const catalog = useInfiniteQuery({
    queryKey: catalogKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchAdminCatalog(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  useEffect(() => {
    if (form === undefined && policy.data !== undefined) {
      setForm(policyInput(policy.data));
    }
  }, [form, policy.data]);

  useEffect(
    () => () => {
      refreshControllerRef.current?.abort();
    },
    [],
  );

  const catalogItems = useMemo(() => {
    const byId = new Map<string, AdminModelCatalogItem>();
    for (const item of catalog.data?.pages.flatMap((page) => page.items) ?? []) {
      byId.set(item.catalogId, item);
    }
    for (const tier of policy.data?.tiers ?? []) {
      byId.set(tier.catalogId, {
        available: tier.catalog.available,
        catalogId: tier.catalogId,
        contextLength: tier.catalog.contextLength,
        displayName: tier.catalog.displayName,
        maximumOutputTokens: tier.catalog.maximumOutputTokens,
        modelId: tier.catalog.modelId,
        validatedAt: tier.catalog.validatedAt,
      });
    }
    return [...byId.values()].sort((left, right) => left.modelId.localeCompare(right.modelId));
  }, [catalog.data, policy.data]);

  const addModel = useMutation({
    mutationFn: () => addAdminCatalogModel({ modelId: modelId.trim() }),
    onSuccess: async () => {
      setModelId("");
      setModelIdValidation(undefined);
      setSuccess(copy.administration.models.added);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: catalogKey }),
        queryClient.invalidateQueries({ queryKey: policyKey }),
      ]);
    },
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const controller = new AbortController();
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = controller;
      let cursor: string | null = null;
      let updated = 0;
      do {
        const result = await refreshAdminCatalog({ cursor }, controller.signal);
        updated += result.updated;
        cursor = result.nextCursor;
      } while (cursor !== null);
      return updated;
    },
    onSuccess: async (updated) => {
      setSuccess(copy.administration.models.refreshed(updated));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: catalogKey }),
        queryClient.invalidateQueries({ queryKey: policyKey }),
        queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.modelTierPolicy(scope),
        }),
      ]);
    },
    onSettled: () => {
      refreshControllerRef.current = undefined;
    },
  });
  const save = useMutation({
    mutationFn: (input: AdminUpdateModelPolicyRequest) => updateAdminPolicy(input),
    onSuccess: async (updated) => {
      setForm(policyInput(updated));
      setPolicyValidation(emptyPolicyValidation());
      setSuccess(copy.administration.models.saved);
      queryClient.setQueryData(policyKey, updated);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.modelTierPolicy(scope),
        }),
        queryClient.invalidateQueries({ queryKey: administrationQueryKeys.usage(scope) }),
      ]);
    },
    onError: async (error) => {
      if (error instanceof AdministrationApiError && error.code === "MODEL_POLICY_CHANGED") {
        const canonical = await policy.refetch();
        if (canonical.data) {
          setForm((current) =>
            current ? { ...current, observedRevision: canonical.data.revision } : current,
          );
        }
      }
    },
  });

  return (
    <section className="admin-page" aria-labelledby="models-title">
      <header className="admin-page-heading">
        <p className="identity-eyebrow">{copy.administration.navigation.label}</p>
        <h1 id="models-title">{copy.administration.models.title}</h1>
        <p>{copy.administration.models.description}</p>
      </header>
      <FormMessage kind="success" message={success} />

      <section className="admin-card" aria-labelledby="catalog-title">
        <div className="admin-card-heading">
          <h2 id="catalog-title">{copy.administration.models.catalogTitle}</h2>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={refresh.isPending || addModel.isPending}
            onClick={() => {
              setSuccess(undefined);
              addModel.reset();
              refresh.mutate();
            }}
          >
            {refresh.isPending
              ? copy.administration.models.refreshing
              : copy.administration.models.refresh}
          </button>
        </div>
        <form
          className="admin-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            beginFeedbackAttempt();
            addModel.reset();
            refresh.reset();
            setSuccess(undefined);
            const error = modelIdError(modelId);
            setModelIdValidation(error);
            if (error) {
              return;
            }
            addModel.mutate();
          }}
          noValidate
          aria-busy={addModel.isPending}
        >
          <div className="form-field admin-grow-field">
            <label htmlFor="catalog-model-id">{copy.administration.models.modelId}</label>
            <input
              id="catalog-model-id"
              required
              value={modelId}
              placeholder="provider/exact-model"
              aria-invalid={Boolean(modelIdValidation)}
              aria-describedby={modelIdValidation ? "catalog-model-id-error" : undefined}
              onChange={(event) => {
                setModelId(event.target.value);
                setModelIdValidation(undefined);
              }}
            />
            <FieldError id="catalog-model-id-error" message={modelIdValidation} />
          </div>
          <button
            className="primary-button"
            type="submit"
            disabled={addModel.isPending || refresh.isPending}
          >
            {addModel.isPending
              ? copy.administration.models.adding
              : copy.administration.models.add}
          </button>
        </form>
        <FormMessage
          focusKey={feedbackAttempt}
          kind="error"
          message={modelIdValidation ? copy.identity.common.validationSummary : undefined}
        />
        {addModel.isError ? <AdministrationError error={addModel.error} /> : null}
        {refresh.isError ? <AdministrationError error={refresh.error} /> : null}
        {catalog.isPending ? (
          <p role="status">{copy.administration.models.catalogLoading}</p>
        ) : null}
        {catalog.isError ? <AdministrationError error={catalog.error} /> : null}
        {!catalog.isPending && !catalog.isError && catalogItems.length === 0 ? (
          <p>{copy.administration.models.catalogEmpty}</p>
        ) : (
          <ul className="admin-catalog-list">
            {catalogItems.map((item) => (
              <li key={item.catalogId}>
                <div className="admin-catalog-identity">
                  <strong>{item.displayName}</strong>
                  <code>{item.modelId}</code>
                  <span className="admin-availability" data-available={item.available}>
                    {item.available
                      ? copy.administration.models.available
                      : copy.administration.models.unavailable}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>{copy.administration.models.contextLimit}</dt>
                    <dd>{catalogIntegerFormatter.format(item.contextLength)}</dd>
                  </div>
                  <div>
                    <dt>{copy.administration.models.catalogOutputLimit}</dt>
                    <dd>{catalogIntegerFormatter.format(item.maximumOutputTokens)}</dd>
                  </div>
                  <div>
                    <dt>{copy.administration.models.lastValidated}</dt>
                    <dd>
                      <time dateTime={item.validatedAt}>
                        {new Date(item.validatedAt).toLocaleString("es-EC")}
                      </time>
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
        {catalog.hasNextPage ? (
          <button
            className="text-button"
            type="button"
            disabled={catalog.isFetchingNextPage}
            onClick={() => void catalog.fetchNextPage()}
          >
            {catalog.isFetchingNextPage
              ? copy.administration.common.loadingMore
              : copy.administration.common.loadMore}
          </button>
        ) : null}
      </section>

      <section className="admin-card" aria-labelledby="policy-title">
        <h2 id="policy-title">{copy.administration.models.policyTitle}</h2>
        {policy.isError ? (
          <AdministrationError error={policy.error} />
        ) : policy.isPending || form === undefined ? (
          <p role="status">{copy.administration.common.loading}</p>
        ) : (
          <form
            className="admin-policy-form"
            onSubmit={(event) => {
              event.preventDefault();
              beginFeedbackAttempt();
              save.reset();
              setSuccess(undefined);
              const validation = validatePolicy(form);
              setPolicyValidation(validation);
              if (hasPolicyError(validation)) {
                return;
              }
              save.mutate(form);
            }}
            noValidate
            aria-busy={save.isPending}
          >
            <FormMessage
              focusKey={feedbackAttempt}
              kind="error"
              message={
                hasPolicyError(policyValidation)
                  ? copy.identity.common.validationSummary
                  : undefined
              }
            />
            <FieldError id="policy-selection-error" message={policyValidation.policy} />
            <section
              className="admin-table-scroll"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: The wide semantic table must be keyboard-scrollable on narrow screens.
              tabIndex={0}
              aria-label={copy.administration.models.policyTitle}
            >
              <table className="admin-table">
                <caption>{copy.administration.models.policyTitle}</caption>
                <thead>
                  <tr>
                    <th scope="col">{copy.administration.models.tier}</th>
                    <th scope="col">{copy.administration.models.model}</th>
                    <th scope="col">{copy.administration.models.enabled}</th>
                    <th scope="col">{copy.administration.models.outputLimit}</th>
                    <th scope="col">{copy.administration.models.defaultTier}</th>
                  </tr>
                </thead>
                <tbody>
                  {form.tiers.map((configured, index) => (
                    <tr key={configured.tier}>
                      <th scope="row">{tierName(configured.tier)}</th>
                      <td>
                        <select
                          aria-label={`${copy.administration.models.model}: ${tierName(configured.tier)}`}
                          value={configured.catalogId}
                          onChange={(event) => {
                            const next = [...form.tiers] as AdminUpdateModelPolicyRequest["tiers"];
                            next[index] = { ...configured, catalogId: event.target.value };
                            setForm({ ...form, tiers: next });
                          }}
                        >
                          {catalogItems.map((item) => (
                            <option key={item.catalogId} value={item.catalogId}>
                              {item.displayName} · {item.modelId}
                              {item.available ? "" : ` · ${copy.administration.models.unavailable}`}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          aria-label={`${copy.administration.models.enabled}: ${tierName(configured.tier)}`}
                          type="checkbox"
                          checked={configured.enabled}
                          onChange={(event) => {
                            const next = [...form.tiers] as AdminUpdateModelPolicyRequest["tiers"];
                            next[index] = { ...configured, enabled: event.target.checked };
                            setPolicyValidation((current) => ({
                              ...current,
                              policy: undefined,
                            }));
                            setForm({ ...form, tiers: next });
                          }}
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`${copy.administration.models.outputLimit}: ${tierName(configured.tier)}`}
                          type="number"
                          min={1}
                          step={1}
                          value={configured.maximumOutputTokens}
                          aria-invalid={Boolean(policyValidation.output[configured.tier])}
                          aria-describedby={
                            policyValidation.output[configured.tier]
                              ? `policy-output-${configured.tier}-error`
                              : undefined
                          }
                          onChange={(event) => {
                            const next = [...form.tiers] as AdminUpdateModelPolicyRequest["tiers"];
                            next[index] = {
                              ...configured,
                              maximumOutputTokens: Number(event.target.value),
                            };
                            setPolicyValidation((current) => ({
                              ...current,
                              output: { ...current.output, [configured.tier]: undefined },
                            }));
                            setForm({ ...form, tiers: next });
                          }}
                        />
                        <FieldError
                          id={`policy-output-${configured.tier}-error`}
                          message={policyValidation.output[configured.tier]}
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`${copy.administration.models.defaultTier}: ${tierName(configured.tier)}`}
                          name="default-tier"
                          type="radio"
                          checked={form.defaultTier === configured.tier}
                          onChange={() => {
                            setPolicyValidation((current) => ({ ...current, policy: undefined }));
                            setForm({ ...form, defaultTier: configured.tier });
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <div className="form-field admin-budget-field">
              <label htmlFor="workspace-budget">{copy.administration.models.monthlyBudget}</label>
              <input
                id="workspace-budget"
                inputMode="decimal"
                required
                value={form.monthlyBudgetUsd}
                aria-invalid={Boolean(policyValidation.budget)}
                aria-describedby={`workspace-budget-help${
                  policyValidation.budget ? " workspace-budget-error" : ""
                }`}
                onChange={(event) => {
                  setPolicyValidation((current) => ({ ...current, budget: undefined }));
                  setForm({ ...form, monthlyBudgetUsd: event.target.value });
                }}
              />
              <p className="field-help" id="workspace-budget-help">
                {copy.administration.models.monthlyBudgetHelp}
              </p>
              <FieldError id="workspace-budget-error" message={policyValidation.budget} />
            </div>
            <button className="primary-button" type="submit" disabled={save.isPending}>
              {save.isPending ? copy.administration.common.saving : copy.administration.common.save}
            </button>
            {save.isError ? <AdministrationError error={save.error} /> : null}
          </form>
        )}
      </section>
    </section>
  );
}
