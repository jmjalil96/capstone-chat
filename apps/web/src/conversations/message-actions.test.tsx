import type { AlternativeContext, ConversationMessage } from "@capstone/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { MessageActions } from "./message-actions";

const userMessage: ConversationMessage = {
  id: "11111111-1111-4111-8111-111111111111",
  parentMessageId: null,
  role: "user",
  content: [{ type: "text", text: "Texto **original**" }],
  createdAt: "2026-08-07T12:00:00.000Z",
  siblingCount: 1,
};

const assistantMessage: ConversationMessage = {
  id: "22222222-2222-4222-8222-222222222222",
  parentMessageId: userMessage.id,
  role: "assistant",
  content: [{ type: "text", text: "Respuesta `exacta`" }],
  createdAt: "2026-08-07T12:00:01.000Z",
  siblingCount: 1,
};

const alternative: AlternativeContext = {
  messageId: assistantMessage.id,
  position: 2,
  total: 3,
  previousLeafMessageId: "33333333-3333-4333-8333-333333333333",
  nextLeafMessageId: "44444444-4444-4444-8444-444444444444",
};

function actions(
  message: ConversationMessage,
  overrides: Partial<ComponentProps<typeof MessageActions>> = {},
) {
  const props: ComponentProps<typeof MessageActions> = {
    alternative: undefined,
    canContinue: false,
    canCopy: true,
    canEdit: message.role === "user",
    canRetry: message.role === "assistant",
    canUndo: false,
    message,
    pending: false,
    onContinue: vi.fn(),
    onEdit: vi.fn(async () => undefined),
    onRetry: vi.fn(),
    onSelectAlternative: vi.fn(),
    onUndo: vi.fn(),
    children: <p>Contenido renderizado</p>,
    ...overrides,
  };
  return { props, ...render(<MessageActions {...props} />) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("message actions", () => {
  it("replaces the rendered body while editing and restores it on explicit cancel", async () => {
    const user = userEvent.setup();
    const { props, rerender } = actions(userMessage);

    await user.click(screen.getByRole("button", { name: copy.conversations.messages.edit }));

    expect(screen.queryByText("Contenido renderizado")).not.toBeInTheDocument();
    const editor = screen.getByRole("textbox", { name: copy.conversations.messages.editLabel });
    expect(editor).toHaveValue("Texto **original**");
    await user.type(editor, "{Enter}segunda línea");
    expect(props.onEdit).not.toHaveBeenCalled();
    rerender(<MessageActions {...props} canEdit={false} />);
    expect(
      screen.getByRole("button", { name: copy.conversations.messages.saveEdit }),
    ).toBeDisabled();
    expect(editor).toHaveValue("Texto **original**\nsegunda línea");

    await user.click(screen.getByRole("button", { name: copy.conversations.messages.cancelEdit }));
    expect(screen.getByText("Contenido renderizado")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: copy.conversations.messages.editLabel }),
    ).toBeNull();
  });

  it("associates the unchanged validation message with the editor", async () => {
    const user = userEvent.setup();
    actions(userMessage);

    await user.click(screen.getByRole("button", { name: copy.conversations.messages.edit }));

    const editor = screen.getByRole("textbox", { name: copy.conversations.messages.editLabel });
    const validation = screen.getByText(copy.conversations.messages.unchangedEdit);
    expect(validation.id).not.toBe("");
    expect(editor).toHaveAttribute("aria-describedby", validation.id);
    expect(editor).toHaveAttribute("aria-invalid", "true");

    await user.type(editor, " con cambios");

    expect(screen.queryByText(copy.conversations.messages.unchangedEdit)).not.toBeInTheDocument();
    expect(editor).not.toHaveAttribute("aria-describedby");
    expect(editor).toHaveAttribute("aria-invalid", "false");
  });

  it("keeps the temporary edit and its exact text after a deterministic rejection", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn(async () => {
      throw new Error("rejected");
    });
    actions(userMessage, { onEdit });
    await user.click(screen.getByRole("button", { name: copy.conversations.messages.edit }));
    const editor = screen.getByRole("textbox", { name: copy.conversations.messages.editLabel });
    await user.clear(editor);
    await user.type(editor, "Edición\nconservada");
    await user.click(screen.getByRole("button", { name: copy.conversations.messages.saveEdit }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      copy.conversations.messages.editFailed,
    );
    expect(editor).toHaveValue("Edición\nconservada");
    expect(screen.queryByText("Contenido renderizado")).not.toBeInTheDocument();
    expect(onEdit).toHaveBeenCalledWith("Edición\nconservada", expect.any(Function));
  });

  it("moves focus into the editor and restores the Edit control on Escape", async () => {
    const user = userEvent.setup();
    actions(userMessage);
    const editButton = screen.getByRole("button", {
      name: copy.conversations.messages.edit,
    });

    await user.click(editButton);
    const editor = screen.getByRole("textbox", { name: copy.conversations.messages.editLabel });
    expect(editor).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("textbox", { name: copy.conversations.messages.editLabel }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: copy.conversations.messages.edit })).toHaveFocus();
  });

  it("closes only after the generation commit callback", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onEdit = vi.fn(async (_content: string, onCommitted: () => void) => {
      onCommitted();
      await pending;
    });
    actions(userMessage, { onEdit });
    await user.click(screen.getByRole("button", { name: copy.conversations.messages.edit }));
    const editor = screen.getByRole("textbox", { name: copy.conversations.messages.editLabel });
    await user.clear(editor);
    await user.type(editor, "Texto confirmado");
    await user.click(screen.getByRole("button", { name: copy.conversations.messages.saveEdit }));

    await waitFor(() => expect(screen.getByText("Contenido renderizado")).toBeInTheDocument());
    expect(
      screen.queryByRole("textbox", { name: copy.conversations.messages.editLabel }),
    ).toBeNull();
    release();
  });

  it("keeps user-message copying exact and clipboard failure local", async () => {
    const user = userEvent.setup();
    let rejectClipboard!: (error: unknown) => void;
    const rejectedClipboard = new Promise<void>((_resolve, reject) => {
      rejectClipboard = reject;
    });
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(rejectedClipboard);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    actions(userMessage);
    const copyButton = screen.getByRole("button", {
      name: copy.conversations.messages.copyUser,
    });

    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith("Texto **original**");
    expect(await screen.findByRole("status")).toHaveTextContent(copy.conversations.messages.copied);
    await user.click(copyButton);
    expect(copyButton).toHaveAttribute("aria-disabled", "true");
    expect(copyButton).not.toBeDisabled();
    expect(copyButton).toHaveFocus();
    await act(async () => rejectClipboard(new Error("clipboard rejected")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      copy.conversations.messages.copyFailed,
    );
    expect(copyButton).toHaveFocus();
  });

  it("exposes adjacent alternatives and Undo as separate controls", async () => {
    const user = userEvent.setup();
    const onSelectAlternative = vi.fn();
    const onUndo = vi.fn();
    actions(assistantMessage, {
      alternative,
      canUndo: true,
      onSelectAlternative,
      onUndo,
    });

    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText(copy.conversations.messages.alternativePosition(2, 3))).toHaveClass(
      "visually-hidden",
    );
    await user.click(
      screen.getByRole("button", { name: copy.conversations.messages.previousAlternative }),
    );
    await user.click(
      screen.getByRole("button", { name: copy.conversations.messages.nextAlternative }),
    );
    await user.click(screen.getByRole("button", { name: copy.conversations.messages.undo }));

    expect(onSelectAlternative).toHaveBeenNthCalledWith(
      1,
      alternative.previousLeafMessageId,
      expect.any(HTMLButtonElement),
    );
    expect(onSelectAlternative).toHaveBeenNthCalledWith(
      2,
      alternative.nextLeafMessageId,
      expect.any(HTMLButtonElement),
    );
    expect(onUndo).toHaveBeenCalledWith(expect.any(HTMLButtonElement));
  });
});

describe("answer reporting", () => {
  it("offers Reportar only for eligible assistant answers and shows the reported state", async () => {
    const user = userEvent.setup();
    const onReport = vi.fn();
    const { rerender, props } = actions(assistantMessage, { canReport: true, onReport });
    const report = screen.getByRole("button", { name: copy.conversations.messages.report });
    await user.click(report);
    expect(onReport).toHaveBeenCalledWith(report);

    rerender(<MessageActions {...props} canReport={false} reported />);
    const reported = screen.getByRole("button", { name: copy.conversations.messages.reported });
    expect(reported).toHaveAttribute("aria-disabled", "true");
    await user.click(reported);
    expect(onReport).toHaveBeenCalledOnce();

    cleanup();
    actions(userMessage, { canReport: true, onReport });
    expect(
      screen.queryByRole("button", { name: copy.conversations.messages.report }),
    ).not.toBeInTheDocument();
  });
});
