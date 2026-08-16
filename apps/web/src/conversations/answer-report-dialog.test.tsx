import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import {
  AnswerReportDialog,
  type AnswerReportTarget,
  answerReportReasons,
} from "./answer-report-dialog";
import { ConversationApiError } from "./api";

const messageId = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  cleanup();
});

describe("answer report dialog", () => {
  it("requires a reason, states the disclosure, and submits the normalized note", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => ({}));
    const onSubmitted = vi.fn();
    const onClose = vi.fn();
    render(
      <AnswerReportDialog
        target={{ messageId, trigger: null }}
        onClose={onClose}
        onSubmit={onSubmit}
        onSubmitted={onSubmitted}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: copy.conversations.report.title });
    expect(dialog).toHaveTextContent(copy.conversations.report.disclosure);
    await user.click(screen.getByRole("button", { name: copy.conversations.report.submit }));
    expect(screen.getByRole("alert")).toHaveTextContent(copy.conversations.report.reasonRequired);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("radio", { name: copy.conversations.report.reasons.outdated }),
    );
    await user.type(
      screen.getByLabelText(copy.conversations.report.noteLabel),
      "  La cifra cambió.  ",
    );
    await user.click(screen.getByRole("button", { name: copy.conversations.report.submit }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(messageId));
    expect(onSubmit).toHaveBeenCalledWith(
      messageId,
      { note: "La cifra cambió.", reason: "outdated", sharePromptAndAnswer: true },
      expect.any(AbortSignal),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("reopens after a successful submission with enabled controls and initial focus", async () => {
    const user = userEvent.setup();
    const secondMessageId = "33333333-3333-4333-8333-333333333333";
    const onSubmit = vi.fn(async () => ({}));
    const onSubmitted = vi.fn();

    function Harness() {
      const [target, setTarget] = useState<AnswerReportTarget>();

      return (
        <>
          <button
            type="button"
            onClick={(event) => setTarget({ messageId, trigger: event.currentTarget })}
          >
            Reportar primera
          </button>
          <button
            type="button"
            onClick={(event) =>
              setTarget({ messageId: secondMessageId, trigger: event.currentTarget })
            }
          >
            Reportar segunda
          </button>
          <AnswerReportDialog
            target={target}
            onClose={() => setTarget(undefined)}
            onSubmit={onSubmit}
            onSubmitted={onSubmitted}
          />
        </>
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Reportar primera" }));
    await user.click(
      screen.getByRole("radio", { name: copy.conversations.report.reasons.outdated }),
    );
    await user.click(screen.getByRole("button", { name: copy.conversations.report.submit }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(messageId));

    const firstReason = document.querySelector<HTMLInputElement>(
      `input[value="${answerReportReasons[0]}"]`,
    );
    expect(firstReason).not.toBeNull();
    expect(firstReason).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Reportar segunda" }));
    const reopenedFirstReason = screen.getByRole("radio", {
      name: copy.conversations.report.reasons.incorrect,
    });
    expect(reopenedFirstReason).toBeEnabled();
    expect(reopenedFirstReason).not.toBeChecked();
    await waitFor(() => expect(reopenedFirstReason).toHaveFocus());
    expect(screen.getByLabelText(copy.conversations.report.noteLabel)).toHaveValue("");
    expect(screen.getByRole("button", { name: copy.conversations.report.submit })).toBeEnabled();
  });

  it("keeps the dialog open with a local alert when the report is rejected", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {
      throw new ConversationApiError(409, "GENERATION_ACTIVE");
    });
    render(
      <AnswerReportDialog
        target={{ messageId, trigger: null }}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onSubmitted={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("radio", { name: copy.conversations.report.reasons.other }));
    await user.click(screen.getByRole("button", { name: copy.conversations.report.submit }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(copy.conversations.report.failed),
    );
    expect(screen.getByRole("dialog", { name: copy.conversations.report.title })).toBeVisible();
  });

  it("rejects malformed Unicode locally and restores focus to the opener on cancel", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    trigger.textContent = "Abrir reporte";
    document.body.append(trigger);
    trigger.focus();
    const onSubmit = vi.fn(async () => ({}));
    render(
      <AnswerReportDialog
        target={{ messageId, trigger }}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onSubmitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("radio", { name: copy.conversations.report.reasons.other }));
    fireEvent.change(screen.getByLabelText(copy.conversations.report.noteLabel), {
      target: { value: "\ud800" },
    });
    expect(screen.getByText(copy.conversations.report.noteInvalid)).toBeVisible();
    expect(screen.getByRole("button", { name: copy.conversations.report.submit })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: copy.conversations.report.cancel }));
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });
});
