import type { SessionResponse } from "@capstone/protocol";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useOutletContext } from "react-router";

import { copy } from "../copy";
import { administrationQueryKeys, administrationQueryScope, fetchAdminUsage } from "./api";
import { AdministrationError } from "./feedback";
import { formatAdminUsd } from "./formatting";

const integerFormatter = new Intl.NumberFormat("es-EC", { maximumFractionDigits: 0 });

function integer(value: string): string {
  return integerFormatter.format(BigInt(value));
}

function periodDate(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("es-EC", {
      dateStyle: "medium",
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleDateString("es-EC");
  }
}

function UsageStateTable({
  error,
  message,
}: {
  readonly error?: unknown;
  readonly message: string;
}) {
  return (
    <section
      className="admin-table-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The wide semantic table must be keyboard-scrollable on narrow screens.
      tabIndex={0}
      aria-label={copy.administration.usage.title}
    >
      <table className="admin-table">
        <caption>{copy.administration.usage.title}</caption>
        <thead>
          <tr>
            <th scope="col">{copy.administration.usage.employee}</th>
            <th scope="col">{copy.administration.usage.tier}</th>
            <th scope="col">{copy.administration.usage.purpose}</th>
            <th scope="col">{copy.administration.usage.generations}</th>
            <th scope="col">{copy.administration.usage.actualCost}</th>
            <th scope="col">{copy.administration.usage.estimatedCost}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={6} role={error ? undefined : "status"}>
              {error ? <AdministrationError error={error} /> : message}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

export function UsagePage() {
  const session = useOutletContext<SessionResponse>();
  const scope = administrationQueryScope(session);
  useEffect(() => {
    document.title = copy.brand.pageTitle(copy.administration.usage.title);
  }, []);
  const usage = useInfiniteQuery({
    queryKey: administrationQueryKeys.usage(scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchAdminUsage(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const first = usage.data?.pages[0];
  const employees = usage.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="admin-page" aria-labelledby="usage-title">
      <header className="admin-page-heading">
        <p className="identity-eyebrow">{copy.administration.navigation.label}</p>
        <h1 id="usage-title">{copy.administration.usage.title}</h1>
        <p>{copy.administration.usage.description}</p>
        {first ? (
          <p className="admin-period">
            <time dateTime={first.period.start}>
              {periodDate(first.period.start, first.period.timezone)}
            </time>
            {" — "}
            <time dateTime={first.period.end}>
              {periodDate(first.period.end, first.period.timezone)}
            </time>
            {` · ${first.period.timezone}`}
          </p>
        ) : null}
      </header>

      {usage.isPending ? <UsageStateTable message={copy.administration.usage.loading} /> : null}
      {usage.isError ? (
        <UsageStateTable error={usage.error} message={copy.administration.common.genericError} />
      ) : null}
      {first ? (
        <dl className="admin-budget-summary">
          <div>
            <dt>{copy.administration.usage.budget}</dt>
            <dd>{formatAdminUsd(first.budget.monthlyBudgetUsd)}</dd>
          </div>
          <div>
            <dt>{copy.administration.usage.actual}</dt>
            <dd>{formatAdminUsd(first.budget.actualCostUsd)}</dd>
          </div>
          <div>
            <dt>{copy.administration.usage.estimated}</dt>
            <dd>{formatAdminUsd(first.budget.estimatedCostUsd)}</dd>
          </div>
          <div>
            <dt>{copy.administration.usage.reserved}</dt>
            <dd>{formatAdminUsd(first.budget.reservedCostUsd)}</dd>
          </div>
          <div>
            <dt>{copy.administration.usage.remaining}</dt>
            <dd>{formatAdminUsd(first.budget.remainingUsd)}</dd>
          </div>
        </dl>
      ) : null}

      {!usage.isPending && !usage.isError && employees.length === 0 ? (
        <UsageStateTable message={copy.administration.usage.empty} />
      ) : null}
      <div className="admin-usage-list">
        {employees.map((item) => (
          <section className="admin-card" key={item.employee.id}>
            <header className="admin-employee-usage-heading">
              <span>
                <h2>{item.employee.name}</h2>
                <p>{item.employee.email}</p>
              </span>
              <span className="admin-soft-budget-summary">
                <span className="visually-hidden">{copy.administration.usage.consumed}: </span>
                {formatAdminUsd(item.softBudget.consumedUsd)}
                {item.softBudget.monthlyBudgetUsd === null
                  ? ""
                  : ` / ${formatAdminUsd(item.softBudget.monthlyBudgetUsd)}`}
              </span>
            </header>
            {item.softBudget.warning ? (
              <p className="form-message" data-kind="error" role="status">
                {copy.administration.usage.softWarning}
              </p>
            ) : null}
            <section
              className="admin-table-scroll"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: The wide semantic table must be keyboard-scrollable on narrow screens.
              tabIndex={0}
              aria-label={`${copy.administration.usage.employee}: ${item.employee.name}`}
            >
              <table className="admin-table">
                <caption>
                  {copy.administration.usage.employee}: {item.employee.name}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{copy.administration.usage.tier}</th>
                    <th scope="col">{copy.administration.usage.purpose}</th>
                    <th scope="col">{copy.administration.usage.generations}</th>
                    <th scope="col">{copy.administration.usage.promptTokens}</th>
                    <th scope="col">{copy.administration.usage.completionTokens}</th>
                    <th scope="col">{copy.administration.usage.reasoningTokens}</th>
                    <th scope="col">{copy.administration.usage.cachedTokens}</th>
                    <th scope="col">{copy.administration.usage.actualCost}</th>
                    <th scope="col">{copy.administration.usage.estimatedCost}</th>
                  </tr>
                </thead>
                <tbody>
                  {item.groups.length === 0 ? (
                    <tr>
                      <td colSpan={9}>{copy.administration.usage.noUsage}</td>
                    </tr>
                  ) : (
                    item.groups.map((group) => (
                      <tr key={`${group.tier}:${group.purpose}`}>
                        <th scope="row">{copy.conversations.modelTiers.tiers[group.tier].name}</th>
                        <td>{copy.administration.usage.purposes[group.purpose]}</td>
                        <td>{integerFormatter.format(group.generationCount)}</td>
                        <td>{integer(group.promptTokens)}</td>
                        <td>{integer(group.completionTokens)}</td>
                        <td>{integer(group.reasoningTokens)}</td>
                        <td>{integer(group.cachedTokens)}</td>
                        <td>{formatAdminUsd(group.actualCostUsd)}</td>
                        <td>{formatAdminUsd(group.estimatedCostUsd)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </section>
          </section>
        ))}
      </div>
      {usage.hasNextPage ? (
        <button
          className="secondary-button"
          type="button"
          disabled={usage.isFetchingNextPage}
          onClick={() => void usage.fetchNextPage()}
        >
          {usage.isFetchingNextPage
            ? copy.administration.common.loadingMore
            : copy.administration.common.loadMore}
        </button>
      ) : null}
    </section>
  );
}
