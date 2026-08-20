import type {
  AdminModelCapability,
  AdminModelCatalogItem,
  AdminModelPolicyResponse,
  AdminParameterSupport,
  AdminReasoningBudgetTokens,
  AdminReasoningEffort,
  AdminRevisionActor,
  AdminTemperaturePreset,
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
  fetchAdminPolicyHistory,
  refreshAdminCatalog,
  revertAdminPolicy,
  updateAdminPolicy,
} from "./api";
import { AdministrationError } from "./feedback";
import { modelIdError, positiveIntegerError, usdError } from "./validation";

const tiers = ["fast", "balanced", "pro"] as const;
const efforts = ["off", "low", "medium", "high"] as const;
const temperaturePresets = ["precise", "balanced", "flexible", "creative"] as const;
const reasoningBudgets = [1_024, 2_048, 4_096, 8_192] as const;

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
        reasoningBudgetTokens: configured.reasoningBudgetTokens,
        reasoningEffort: configured.reasoningEffort,
        temperaturePreset: configured.temperaturePreset,
        tier,
      };
    }) as AdminUpdateModelPolicyRequest["tiers"],
  };
}

interface PolicyValidation {
  readonly budget: string | undefined;
  readonly output: Record<GenerationModelTier, string | undefined>;
  readonly policy: string | undefined;
  readonly reasoning: Record<GenerationModelTier, string | undefined>;
}

function emptyPolicyValidation(): PolicyValidation {
  return {
    budget: undefined,
    output: { balanced: undefined, fast: undefined, pro: undefined },
    policy: undefined,
    reasoning: { balanced: undefined, fast: undefined, pro: undefined },
  };
}

function validatePolicy(input: AdminUpdateModelPolicyRequest): PolicyValidation {
  const enabled = input.tiers.filter((tier) => tier.enabled);
  const defaultTier = input.tiers.find((tier) => tier.tier === input.defaultTier);
  const output = emptyPolicyValidation().output;
  const reasoning = emptyPolicyValidation().reasoning;
  for (const tier of input.tiers) {
    output[tier.tier] = positiveIntegerError(tier.maximumOutputTokens);
    reasoning[tier.tier] =
      (tier.reasoningEffort === "off" && tier.reasoningBudgetTokens !== 0) ||
      (tier.reasoningEffort !== "off" &&
        (tier.reasoningBudgetTokens === 0 ||
          tier.reasoningBudgetTokens > tier.maximumOutputTokens - 1_024))
        ? copy.administration.models.invalidReasoning
        : undefined;
  }
  return {
    budget: usdError(input.monthlyBudgetUsd),
    output,
    policy:
      enabled.length === 0 || !defaultTier?.enabled
        ? copy.administration.models.policyInvalid
        : undefined,
    reasoning,
  };
}

function hasPolicyError(validation: PolicyValidation): boolean {
  return Boolean(
    validation.budget ||
      validation.policy ||
      Object.values(validation.output).some(Boolean) ||
      Object.values(validation.reasoning).some(Boolean),
  );
}

const catalogIntegerFormatter = new Intl.NumberFormat("es-EC", { maximumFractionDigits: 0 });

function actorName(actor: AdminRevisionActor): string {
  return actor.kind === "system" ? actor.label : actor.displayName;
}

function validReasoningBudgets(maximumOutputTokens: number): readonly AdminReasoningBudgetTokens[] {
  return reasoningBudgets.filter((budget) => budget <= maximumOutputTokens - 1_024);
}

function effortValues(capability: AdminModelCapability): readonly string[] {
  const support = capability.reasoning.effortSupport;
  if (support.kind === "none") {
    return [];
  }
  return support.kind === "all"
    ? ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
    : support.values;
}

function draftStatuses(
  configured: AdminUpdateModelPolicyRequest["tiers"][number],
  capability: AdminModelCapability,
): {
  readonly temperature: AdminParameterSupport;
  readonly effort: AdminParameterSupport;
  readonly budget: AdminParameterSupport;
} {
  if (capability.reasoning.kind === "unverified") {
    const status = { kind: "unsupported", reason: "capability_unverified" } as const;
    return { temperature: status, effort: status, budget: status };
  }
  const temperature = capability.temperatureSupported
    ? ({ kind: "exact", reason: "supported" } as const)
    : ({ kind: "unsupported", reason: "temperature_unsupported" } as const);
  if (capability.reasoning.kind === "none") {
    const status = { kind: "unsupported", reason: "non_reasoning_model" } as const;
    return { temperature, effort: status, budget: status };
  }
  if (configured.reasoningEffort === "off") {
    const status =
      capability.reasoning.kind === "mandatory"
        ? ({ kind: "mandatory", reason: "mandatory_reasoning" } as const)
        : ({ kind: "exact", reason: "reasoning_disabled" } as const);
    return { temperature, effort: status, budget: status };
  }
  if (capability.reasoning.maxTokensAccepted) {
    const status = {
      kind: "translated",
      reason: "max_tokens_precision_unverified",
    } as const;
    return { temperature, effort: status, budget: status };
  }
  const supported = effortValues(capability).filter((effort) => effort !== "none");
  if (supported.length > 0) {
    return {
      temperature,
      effort: supported.includes(configured.reasoningEffort)
        ? { kind: "exact", reason: "supported" }
        : { kind: "translated", reason: "effort_nearest_supported" },
      budget: { kind: "unsupported", reason: "budget_control_unavailable" },
    };
  }
  return {
    temperature,
    effort: { kind: "unsupported", reason: "effort_control_unavailable" },
    budget: { kind: "unsupported", reason: "budget_control_unavailable" },
  };
}

function ParameterStatus({ status }: { readonly status: AdminParameterSupport }) {
  return (
    <span className="admin-parameter-status-detail">
      <span className="admin-parameter-status" data-kind={status.kind}>
        {copy.administration.models.statusKinds[status.kind]}
      </span>
      <small>{copy.administration.models.statusReasons[status.reason]}</small>
    </span>
  );
}

function CapabilitySummary({ capability }: { readonly capability: AdminModelCapability }) {
  const effortSupport = capability.reasoning.effortSupport;
  return (
    <dl className="admin-capability-list">
      <div>
        <dt>{copy.administration.models.temperatureCapability}</dt>
        <dd>
          {capability.temperatureSupported
            ? copy.administration.models.supported
            : copy.administration.models.unsupported}
        </dd>
      </div>
      <div>
        <dt>{copy.administration.models.reasoningCapability}</dt>
        <dd>{copy.administration.models.reasoningKinds[capability.reasoning.kind]}</dd>
      </div>
      <div>
        <dt>{copy.administration.models.effortCapability}</dt>
        <dd>
          {effortSupport.kind === "listed"
            ? copy.administration.models.effortSupport.listed(effortSupport.values)
            : copy.administration.models.effortSupport[effortSupport.kind]}
        </dd>
      </div>
      <div>
        <dt>{copy.administration.models.budgetCapability}</dt>
        <dd>
          {capability.reasoning.maxTokensAccepted
            ? copy.administration.models.supported
            : copy.administration.models.unsupported}
        </dd>
      </div>
      <div>
        <dt>{copy.administration.models.traceCapability}</dt>
        <dd>{copy.administration.models.traceSafety[capability.reasoning.traceSafety]}</dd>
      </div>
    </dl>
  );
}

function PolicySnapshotTable({ snapshot }: { readonly snapshot: AdminModelPolicyResponse }) {
  return (
    <section
      className="admin-table-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The complete snapshot table must remain keyboard-scrollable.
      tabIndex={0}
      aria-label={copy.administration.models.revision(snapshot.revision)}
    >
      <table className="admin-table admin-policy-history-table">
        <caption>{copy.administration.models.revision(snapshot.revision)}</caption>
        <thead>
          <tr>
            <th scope="col">{copy.administration.models.tier}</th>
            <th scope="col">{copy.administration.models.model}</th>
            <th scope="col">{copy.administration.models.enabled}</th>
            <th scope="col">{copy.administration.models.outputLimit}</th>
            <th scope="col">{copy.administration.models.effort}</th>
            <th scope="col">{copy.administration.models.reasoningBudget}</th>
            <th scope="col">{copy.administration.models.temperature}</th>
            <th scope="col">{copy.administration.models.parameterStatus}</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.tiers.map((configured) => (
            <tr key={configured.tier}>
              <th scope="row">{tierName(configured.tier)}</th>
              <td>
                <strong>{configured.catalog.displayName}</strong>
                <code>{configured.catalog.modelId}</code>
              </td>
              <td>
                {configured.enabled
                  ? copy.administration.models.yes
                  : copy.administration.models.no}
              </td>
              <td>{catalogIntegerFormatter.format(configured.maximumOutputTokens)}</td>
              <td>{copy.administration.models.effortOptions[configured.reasoningEffort]}</td>
              <td>{catalogIntegerFormatter.format(configured.reasoningBudgetTokens)}</td>
              <td>{copy.administration.models.temperatureOptions[configured.temperaturePreset]}</td>
              <td>
                <div className="admin-tier-statuses">
                  <span>
                    {copy.administration.models.temperature}:{" "}
                    <ParameterStatus status={configured.temperatureStatus} />
                  </span>
                  <span>
                    {copy.administration.models.effort}:{" "}
                    <ParameterStatus status={configured.effortStatus} />
                  </span>
                  <span>
                    {copy.administration.models.reasoningBudget}:{" "}
                    <ParameterStatus status={configured.budgetStatus} />
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ModelsPage() {
  const session = useOutletContext<SessionResponse>();
  const scope = administrationQueryScope(session);
  const queryClient = useQueryClient();
  const policyKey = administrationQueryKeys.policy(scope);
  const policyHistoryKey = administrationQueryKeys.policyHistory(scope);
  const catalogKey = administrationQueryKeys.catalog(scope);
  const [form, setForm] = useState<AdminUpdateModelPolicyRequest>();
  const [modelId, setModelId] = useState("");
  const [success, setSuccess] = useState<string>();
  const [modelIdValidation, setModelIdValidation] = useState<string>();
  const [policyValidation, setPolicyValidation] = useState<PolicyValidation>(emptyPolicyValidation);
  const [feedbackAttempt, beginFeedbackAttempt] = useFeedbackAttempt();
  const [revertRevision, setRevertRevision] = useState<AdminModelPolicyResponse>();
  const refreshControllerRef = useRef<AbortController | undefined>(undefined);
  const revertDialogRef = useRef<HTMLDialogElement>(null);
  const revertButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.title = copy.brand.pageTitle(copy.administration.models.title);
  }, []);

  const policy = useQuery({
    queryKey: policyKey,
    queryFn: ({ signal }) => fetchAdminPolicy(signal),
  });
  const policyHistory = useInfiniteQuery({
    queryKey: policyHistoryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchAdminPolicyHistory(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
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
        capability: tier.catalog.capability,
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
        queryClient.invalidateQueries({ queryKey: policyHistoryKey }),
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
  const revert = useMutation({
    mutationFn: (revision: number) => {
      if (!policy.data) {
        throw new Error("The administration policy is incomplete.");
      }
      return revertAdminPolicy(revision, { observedRevision: policy.data.revision });
    },
    onSuccess: async (updated) => {
      closeRevertDialog();
      setForm(policyInput(updated));
      setPolicyValidation(emptyPolicyValidation());
      setSuccess(copy.administration.models.reverted);
      queryClient.setQueryData(policyKey, updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: policyHistoryKey }),
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

  const mutating = save.isPending || revert.isPending;
  const historyItems = policyHistory.data?.pages.flatMap((page) => page.items) ?? [];
  const unchanged = Boolean(
    form && policy.data && JSON.stringify(form) === JSON.stringify(policyInput(policy.data)),
  );

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
                <div className="admin-catalog-details">
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
                  <CapabilitySummary capability={item.capability} />
                </div>
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
        <p className="admin-card-description">{copy.administration.models.outputEnvelope}</p>
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
            aria-busy={mutating}
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
                    <th scope="col">{copy.administration.models.effort}</th>
                    <th scope="col">{copy.administration.models.reasoningBudget}</th>
                    <th scope="col">{copy.administration.models.temperature}</th>
                    <th scope="col">{copy.administration.models.parameterStatus}</th>
                    <th scope="col">{copy.administration.models.defaultTier}</th>
                  </tr>
                </thead>
                <tbody>
                  {form.tiers.map((configured, index) => {
                    const selectedCatalog = catalogItems.find(
                      (item) => item.catalogId === configured.catalogId,
                    );
                    const status = selectedCatalog
                      ? draftStatuses(configured, selectedCatalog.capability)
                      : undefined;
                    const budgetChoices = validReasoningBudgets(configured.maximumOutputTokens);
                    const budgetIsOutsideChoices =
                      configured.reasoningEffort !== "off" &&
                      !budgetChoices.includes(configured.reasoningBudgetTokens);
                    return (
                      <tr key={configured.tier}>
                        <th scope="row">{tierName(configured.tier)}</th>
                        <td>
                          <select
                            aria-label={`${copy.administration.models.model}: ${tierName(configured.tier)}`}
                            value={configured.catalogId}
                            onChange={(event) => {
                              const next = [
                                ...form.tiers,
                              ] as AdminUpdateModelPolicyRequest["tiers"];
                              next[index] = { ...configured, catalogId: event.target.value };
                              setForm({ ...form, tiers: next });
                            }}
                          >
                            {catalogItems.map((item) => (
                              <option key={item.catalogId} value={item.catalogId}>
                                {item.displayName} · {item.modelId}
                                {item.available
                                  ? ""
                                  : ` · ${copy.administration.models.unavailable}`}
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
                              const next = [
                                ...form.tiers,
                              ] as AdminUpdateModelPolicyRequest["tiers"];
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
                              const next = [
                                ...form.tiers,
                              ] as AdminUpdateModelPolicyRequest["tiers"];
                              next[index] = {
                                ...configured,
                                maximumOutputTokens: Number(event.target.value),
                              };
                              setPolicyValidation((current) => ({
                                ...current,
                                output: {
                                  ...current.output,
                                  [configured.tier]: undefined,
                                },
                                reasoning: {
                                  ...current.reasoning,
                                  [configured.tier]: undefined,
                                },
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
                          <select
                            aria-label={`${copy.administration.models.effort}: ${tierName(configured.tier)}`}
                            value={configured.reasoningEffort}
                            onChange={(event) => {
                              const reasoningEffort = event.target.value as AdminReasoningEffort;
                              const choices = validReasoningBudgets(configured.maximumOutputTokens);
                              const next = [
                                ...form.tiers,
                              ] as AdminUpdateModelPolicyRequest["tiers"];
                              next[index] = {
                                ...configured,
                                reasoningEffort,
                                reasoningBudgetTokens:
                                  reasoningEffort === "off"
                                    ? 0
                                    : configured.reasoningBudgetTokens === 0
                                      ? (choices[0] ?? 1_024)
                                      : configured.reasoningBudgetTokens,
                              };
                              setPolicyValidation((current) => ({
                                ...current,
                                reasoning: {
                                  ...current.reasoning,
                                  [configured.tier]: undefined,
                                },
                              }));
                              setForm({ ...form, tiers: next });
                            }}
                          >
                            {efforts.map((effort) => (
                              <option key={effort} value={effort}>
                                {copy.administration.models.effortOptions[effort]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            aria-label={`${copy.administration.models.reasoningBudget}: ${tierName(configured.tier)}`}
                            value={configured.reasoningBudgetTokens}
                            disabled={configured.reasoningEffort === "off"}
                            aria-invalid={Boolean(policyValidation.reasoning[configured.tier])}
                            aria-describedby={
                              policyValidation.reasoning[configured.tier]
                                ? `policy-reasoning-${configured.tier}-error`
                                : undefined
                            }
                            onChange={(event) => {
                              const next = [
                                ...form.tiers,
                              ] as AdminUpdateModelPolicyRequest["tiers"];
                              next[index] = {
                                ...configured,
                                reasoningBudgetTokens: Number(
                                  event.target.value,
                                ) as AdminReasoningBudgetTokens,
                              };
                              setPolicyValidation((current) => ({
                                ...current,
                                reasoning: {
                                  ...current.reasoning,
                                  [configured.tier]: undefined,
                                },
                              }));
                              setForm({ ...form, tiers: next });
                            }}
                          >
                            {configured.reasoningEffort === "off" ? (
                              <option value={0}>{copy.administration.models.budgetDisabled}</option>
                            ) : (
                              <>
                                {budgetIsOutsideChoices ? (
                                  <option value={configured.reasoningBudgetTokens}>
                                    {copy.administration.models.budgetOutsideLimit(
                                      configured.reasoningBudgetTokens,
                                    )}
                                  </option>
                                ) : null}
                                {budgetChoices.map((budget) => (
                                  <option key={budget} value={budget}>
                                    {catalogIntegerFormatter.format(budget)}
                                  </option>
                                ))}
                              </>
                            )}
                          </select>
                          <FieldError
                            id={`policy-reasoning-${configured.tier}-error`}
                            message={policyValidation.reasoning[configured.tier]}
                          />
                        </td>
                        <td>
                          <select
                            aria-label={`${copy.administration.models.temperature}: ${tierName(configured.tier)}`}
                            value={configured.temperaturePreset}
                            onChange={(event) => {
                              const next = [
                                ...form.tiers,
                              ] as AdminUpdateModelPolicyRequest["tiers"];
                              next[index] = {
                                ...configured,
                                temperaturePreset: event.target.value as AdminTemperaturePreset,
                              };
                              setForm({ ...form, tiers: next });
                            }}
                          >
                            {temperaturePresets.map((preset) => (
                              <option key={preset} value={preset}>
                                {copy.administration.models.temperatureOptions[preset]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          {status ? (
                            <div className="admin-tier-statuses">
                              <span>
                                {copy.administration.models.temperature}:{" "}
                                <ParameterStatus status={status.temperature} />
                              </span>
                              <span>
                                {copy.administration.models.effort}:{" "}
                                <ParameterStatus status={status.effort} />
                              </span>
                              <span>
                                {copy.administration.models.reasoningBudget}:{" "}
                                <ParameterStatus status={status.budget} />
                              </span>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <input
                            aria-label={`${copy.administration.models.defaultTier}: ${tierName(configured.tier)}`}
                            name="default-tier"
                            type="radio"
                            checked={form.defaultTier === configured.tier}
                            onChange={() => {
                              setPolicyValidation((current) => ({
                                ...current,
                                policy: undefined,
                              }));
                              setForm({ ...form, defaultTier: configured.tier });
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
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
            <button className="primary-button" type="submit" disabled={mutating || unchanged}>
              {save.isPending ? copy.administration.common.saving : copy.administration.common.save}
            </button>
            {save.isError ? <AdministrationError error={save.error} /> : null}
          </form>
        )}
      </section>

      <section className="admin-card" aria-labelledby="policy-history-title">
        <h2 id="policy-history-title">{copy.administration.models.historyTitle}</h2>
        <p className="admin-card-description">{copy.administration.models.historyDescription}</p>
        {policyHistory.isPending ? (
          <p role="status">{copy.administration.common.loading}</p>
        ) : policyHistory.isError ? (
          <AdministrationError error={policyHistory.error} />
        ) : historyItems.length === 0 ? (
          <p>{copy.administration.models.historyEmpty}</p>
        ) : (
          <ol className="admin-revision-list">
            {historyItems.map((item) => (
              <li key={item.revision}>
                <article className="admin-revision admin-policy-revision">
                  <header>
                    <div>
                      <h3>{copy.administration.models.revision(item.revision)}</h3>
                      <p>
                        {copy.administration.models.updatedBy(
                          actorName(item.actor),
                          new Date(item.updatedAt).toLocaleString("es-EC"),
                        )}
                      </p>
                      <p>{copy.administration.models.changeKinds[item.changeKind]}</p>
                      {item.revertedFromRevision ? (
                        <p>{copy.administration.models.revertedFrom(item.revertedFromRevision)}</p>
                      ) : null}
                    </div>
                    {item.revision === policy.data?.revision ? (
                      <span className="admin-current-badge">
                        {copy.administration.models.currentRevision}
                      </span>
                    ) : (
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        disabled={mutating}
                        aria-label={`${copy.administration.common.revert}: ${copy.administration.models.revision(item.revision)}`}
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
                  <dl className="admin-policy-revision-summary">
                    <div>
                      <dt>{copy.administration.models.defaultTier}</dt>
                      <dd>{tierName(item.defaultTier)}</dd>
                    </div>
                    <div>
                      <dt>{copy.administration.models.monthlyBudget}</dt>
                      <dd>{item.monthlyBudgetUsd}</dd>
                    </div>
                  </dl>
                  <PolicySnapshotTable snapshot={item} />
                </article>
              </li>
            ))}
          </ol>
        )}
        {policyHistory.hasNextPage ? (
          <button
            className="text-button"
            type="button"
            disabled={policyHistory.isFetchingNextPage}
            onClick={() => void policyHistory.fetchNextPage()}
          >
            {policyHistory.isFetchingNextPage
              ? copy.administration.common.loadingMore
              : copy.administration.common.loadMore}
          </button>
        ) : null}
      </section>

      <dialog
        className="confirmation-dialog"
        ref={revertDialogRef}
        aria-labelledby="policy-revert-title"
        onClose={() => {
          setRevertRevision(undefined);
          revertButtonRef.current?.focus();
        }}
      >
        <h2 id="policy-revert-title">{copy.administration.models.revertTitle}</h2>
        <p>
          {revertRevision ? copy.administration.models.revertNotice(revertRevision.revision) : ""}
        </p>
        {revertRevision ? (
          <>
            <dl className="admin-policy-revision-summary">
              <div>
                <dt>{copy.administration.models.defaultTier}</dt>
                <dd>{tierName(revertRevision.defaultTier)}</dd>
              </div>
              <div>
                <dt>{copy.administration.models.monthlyBudget}</dt>
                <dd>{revertRevision.monthlyBudgetUsd}</dd>
              </div>
            </dl>
            <PolicySnapshotTable snapshot={revertRevision} />
          </>
        ) : null}
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
