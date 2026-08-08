import type { DraftState } from "@capstone/protocol";
import { describe, expect, it } from "vitest";

import {
  acceptServerDraft,
  adoptRefreshedDraft,
  beginDraftSave,
  completeDraftSave,
  consumeConfirmedDraft,
  editDraft,
  initializeDraft,
  markDraftConflict,
  prepareDraftReplacement,
} from "./draft-state";

const serverDraft: DraftState = {
  scope: { kind: "new" },
  content: "Servidor",
  revision: 4,
  updatedAt: "2026-08-06T12:00:00.000Z",
};

describe("draft state", () => {
  it("does not mark newer local text as saved by an older response", () => {
    const edited = editDraft(initializeDraft(serverDraft), "Primera versión");
    const saving = beginDraftSave(edited, edited.editVersion);
    const newer = editDraft(saving, "Versión más reciente");
    const saved = completeDraftSave(
      newer,
      { ...serverDraft, content: "Primera versión", revision: 5 },
      "Primera versión",
      edited.editVersion,
    );

    expect(saved).toMatchObject({
      content: "Versión más reciente",
      dirty: true,
      revision: 5,
      status: "unsaved",
    });
  });

  it("consumes only the exact confirmed draft identity", () => {
    const confirmed = editDraft(initializeDraft(serverDraft), "Mensaje enviado");
    const saved = completeDraftSave(
      confirmed,
      { ...serverDraft, content: confirmed.content, revision: 5 },
      confirmed.content,
      confirmed.editVersion,
    );
    const empty = { ...serverDraft, content: "", revision: 0, updatedAt: null };
    const identity = {
      content: saved.content,
      editVersion: saved.editVersion,
      revision: saved.revision,
    };
    const sentCanonical = {
      ...serverDraft,
      content: saved.content,
      revision: saved.revision,
    };

    expect(consumeConfirmedDraft(saved, identity, empty, sentCanonical).record).toMatchObject({
      content: "",
      dirty: false,
      revision: 0,
    });
    const staleCachedDraft = {
      ...serverDraft,
      content: "Borrador anterior",
      revision: saved.revision - 1,
    };
    expect(consumeConfirmedDraft(saved, identity, empty, staleCachedDraft)).toMatchObject({
      canonical: empty,
      record: {
        content: "",
        dirty: false,
        revision: 0,
      },
    });

    const interveningEdit = editDraft(saved, "Siguiente mensaje");
    expect(
      consumeConfirmedDraft(interveningEdit, identity, empty, sentCanonical).record,
    ).toMatchObject({
      blocked: false,
      content: "Siguiente mensaje",
      dirty: true,
      revision: 0,
      status: "unsaved",
    });

    const editedBackToSameText = editDraft(interveningEdit, saved.content);
    expect(
      consumeConfirmedDraft(editedBackToSameText, identity, empty, sentCanonical).record,
    ).toMatchObject({
      content: saved.content,
      dirty: true,
      revision: 0,
      status: "unsaved",
    });

    const nextCanonical = {
      ...empty,
      content: "Siguiente borrador guardado",
      revision: 1,
      updatedAt: "2026-08-07T12:30:00.000Z",
    };
    const dirtyNextDraft = editDraft(initializeDraft(nextCanonical), "Edición posterior");
    const consumed = consumeConfirmedDraft(dirtyNextDraft, identity, empty, nextCanonical);
    expect(consumed.canonical).toBe(nextCanonical);
    expect(consumed.record).toMatchObject({
      blocked: false,
      content: "Edición posterior",
      dirty: true,
      revision: 1,
      status: "unsaved",
    });

    const crossTabDraft = {
      ...empty,
      content: "Borrador de otra pestaña",
      revision: 1,
      updatedAt: "2026-08-07T12:31:00.000Z",
    };
    const dirtyFromConsumedBase = editDraft(initializeDraft(empty), "Borrador local");
    expect(
      consumeConfirmedDraft(dirtyFromConsumedBase, identity, empty, crossTabDraft).record,
    ).toMatchObject({
      blocked: true,
      conflict: crossTabDraft,
      content: "Borrador local",
      dirty: true,
      revision: 1,
      status: "conflict",
    });

    expect(
      consumeConfirmedDraft(initializeDraft(nextCanonical), identity, empty, nextCanonical).record,
    ).toMatchObject({
      content: "Siguiente borrador guardado",
      dirty: false,
      revision: 1,
      status: "saved",
    });
    const newerConflict = markDraftConflict(interveningEdit, nextCanonical);
    expect(
      consumeConfirmedDraft(newerConflict, identity, empty, nextCanonical).record,
    ).toMatchObject({
      blocked: true,
      conflict: nextCanonical,
      content: "Siguiente mensaje",
      revision: 1,
      status: "conflict",
    });
  });

  it("keeps a stale local draft until the employee chooses a version", () => {
    const local = editDraft(initializeDraft(serverDraft), "Texto local");
    const changed = markDraftConflict(local, {
      ...serverDraft,
      content: "Texto de otra pestaña",
      revision: 5,
    });

    expect(changed).toMatchObject({ blocked: true, content: "Texto local", status: "conflict" });
    expect(acceptServerDraft(changed)).toMatchObject({
      blocked: false,
      content: "Texto de otra pestaña",
      dirty: false,
      revision: 5,
    });
    expect(prepareDraftReplacement(changed)).toMatchObject({
      blocked: false,
      content: "Texto local",
      dirty: true,
      revision: 5,
    });
  });

  it("adopts refreshed server text only while local memory is clean", () => {
    const clean = initializeDraft(serverDraft);
    const refreshed = { ...serverDraft, content: "Servidor actualizado", revision: 5 };

    expect(adoptRefreshedDraft(clean, refreshed)).toMatchObject({
      content: "Servidor actualizado",
      revision: 5,
    });
    expect(adoptRefreshedDraft(editDraft(clean, "Local pendiente"), refreshed)).toMatchObject({
      content: "Local pendiente",
      dirty: true,
      revision: 4,
    });
    expect(
      adoptRefreshedDraft({ ...clean, content: "Respuesta más nueva", revision: 6 }, refreshed),
    ).toMatchObject({ content: "Respuesta más nueva", revision: 6 });
  });
});
