import type { AdminAnswerReport, SessionResponse } from "@capstone/protocol";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useOutletContext } from "react-router";

import { copy } from "../copy";
import {
  AdministrationApiError,
  administrationQueryKeys,
  administrationQueryScope,
  fetchAdminAnswerReport,
  fetchAdminAnswerReports,
} from "./api";
import { AdministrationError } from "./feedback";

const dateFormatter = new Intl.DateTimeFormat("es-EC", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string): string {
  try {
    return dateFormatter.format(new Date(value));
  } catch {
    return value;
  }
}

/**
 * Read-only administrator inbox. The prompt/answer pair is fetched only when a report is opened,
 * and a report that disappears with its source closes the dialog and refreshes the list.
 */
export function ReportsPage() {
  const session = useOutletContext<SessionResponse>();
  const scope = administrationQueryScope(session);
  const queryClient = useQueryClient();
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const announcementRef = useRef<HTMLParagraphElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closingRef = useRef(false);
  const pendingFocusRef = useRef<"announcement" | "trigger" | undefined>(undefined);
  const [selected, setSelected] = useState<AdminAnswerReport>();
  const [announcement, setAnnouncement] = useState<string>();

  useEffect(() => {
    document.title = copy.brand.pageTitle(copy.administration.reports.title);
  }, []);

  const reports = useInfiniteQuery({
    queryKey: administrationQueryKeys.reports(scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchAdminAnswerReports(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchOnWindowFocus: true,
  });
  const detail = useQuery({
    queryKey: administrationQueryKeys.report(scope, selected?.id ?? "none"),
    queryFn: ({ signal }) => fetchAdminAnswerReport(selected?.id ?? "", signal),
    enabled: selected !== undefined,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const items = reports.data?.pages.flatMap((page) => page.items) ?? [];

  const closeDialog = useCallback((focus: "announcement" | "trigger" = "trigger") => {
    if (closingRef.current) {
      return;
    }
    closingRef.current = true;
    const dialog = dialogRef.current;
    if (dialog?.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
    pendingFocusRef.current = focus;
    setSelected(undefined);
  }, []);

  useEffect(() => {
    if (selected !== undefined || pendingFocusRef.current === undefined) {
      return;
    }
    const pending = pendingFocusRef.current;
    pendingFocusRef.current = undefined;
    queueMicrotask(() => {
      if (pending === "announcement") {
        announcementRef.current?.focus();
        return;
      }
      if (triggerRef.current?.isConnected) {
        triggerRef.current.focus();
      }
    });
  }, [selected]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (selected) {
      closingRef.current = false;
      if (typeof dialog.showModal === "function") {
        if (!dialog.open) {
          dialog.showModal();
        }
      } else {
        dialog.setAttribute("open", "");
      }
      return;
    }
    if (dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [selected]);

  const detailGone = detail.error instanceof AdministrationApiError && detail.error.status === 404;
  useEffect(() => {
    if (!detailGone || !selected) {
      return;
    }
    const detailKey = administrationQueryKeys.report(scope, selected.id);
    setAnnouncement(copy.administration.reports.unavailable);
    closeDialog("announcement");
    queueMicrotask(() => queryClient.removeQueries({ exact: true, queryKey: detailKey }));
    void queryClient.invalidateQueries({ queryKey: administrationQueryKeys.reports(scope) });
  }, [closeDialog, detailGone, queryClient, scope, selected]);

  return (
    <section className="admin-page" aria-labelledby="reports-title">
      <header className="admin-page-heading">
        <p className="identity-eyebrow">{copy.administration.navigation.label}</p>
        <h1 id="reports-title">{copy.administration.reports.title}</h1>
        <p>{copy.administration.reports.description}</p>
      </header>
      {announcement ? (
        <p className="form-message" ref={announcementRef} role="status" tabIndex={-1}>
          {announcement}
        </p>
      ) : null}
      {reports.isPending ? (
        <p role="status">{copy.administration.reports.loading}</p>
      ) : reports.isError ? (
        <AdministrationError error={reports.error} />
      ) : items.length === 0 ? (
        <p role="status">{copy.administration.reports.empty}</p>
      ) : (
        <ul className="admin-report-list">
          {items.map((report, index) => (
            <li className="admin-report-item" key={report.id}>
              <header>
                <div>
                  <strong>{report.reporter.name}</strong>
                  <p>{report.reporter.email}</p>
                </div>
                <div>
                  <p>
                    <span className="visually-hidden">{copy.administration.reports.reason}: </span>
                    {copy.administration.reports.reasons[report.reason]}
                  </p>
                  <p>
                    <span className="visually-hidden">
                      {copy.administration.reports.createdAt}:{" "}
                    </span>
                    <time dateTime={report.createdAt}>{formatDate(report.createdAt)}</time>
                  </p>
                </div>
              </header>
              {report.note ? (
                <p className="admin-report-note">
                  <span className="visually-hidden">{copy.administration.reports.note}: </span>
                  {report.note}
                </p>
              ) : null}
              <div>
                <button
                  className="secondary-button compact-button"
                  type="button"
                  aria-label={copy.administration.reports.openFor(
                    index + 1,
                    report.reporter.name,
                    copy.administration.reports.reasons[report.reason],
                    formatDate(report.createdAt),
                  )}
                  onClick={(event) => {
                    triggerRef.current = event.currentTarget;
                    closingRef.current = false;
                    setAnnouncement(undefined);
                    setSelected(report);
                  }}
                >
                  {copy.administration.reports.open}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {reports.hasNextPage ? (
        <button
          className="secondary-button"
          type="button"
          disabled={reports.isFetchingNextPage}
          onClick={() => void reports.fetchNextPage()}
        >
          {reports.isFetchingNextPage
            ? copy.administration.common.loadingMore
            : copy.administration.common.loadMore}
        </button>
      ) : null}

      <dialog
        className="action-dialog admin-report-dialog"
        ref={dialogRef}
        aria-labelledby={`${id}-title`}
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        onClose={() => {
          if (selected && !closingRef.current) {
            closeDialog();
          }
        }}
      >
        <h2 id={`${id}-title`}>{copy.administration.reports.detailTitle}</h2>
        {selected ? (
          <p>
            <strong>{selected.reporter.name}</strong> ·{" "}
            {copy.administration.reports.reasons[selected.reason]} ·{" "}
            <time dateTime={selected.createdAt}>{formatDate(selected.createdAt)}</time>
          </p>
        ) : null}
        {selected?.note ? <p className="admin-report-note">{selected.note}</p> : null}
        {detail.isPending && selected ? (
          <p role="status">{copy.administration.reports.loadingDetail}</p>
        ) : null}
        {detail.isError && !detailGone ? <AdministrationError error={detail.error} /> : null}
        {detail.isSuccess && !detailGone && detail.data ? (
          <div className="admin-report-exchange">
            <section aria-labelledby={`${id}-prompt`}>
              <h3 id={`${id}-prompt`}>{copy.administration.reports.prompt}</h3>
              <pre>{detail.data.exchange.prompt}</pre>
            </section>
            <section aria-labelledby={`${id}-answer`}>
              <h3 id={`${id}-answer`}>{copy.administration.reports.answer}</h3>
              <pre>{detail.data.exchange.answer}</pre>
            </section>
          </div>
        ) : null}
        <div className="dialog-actions">
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => closeDialog()}
          >
            {copy.administration.reports.close}
          </button>
        </div>
      </dialog>
    </section>
  );
}
