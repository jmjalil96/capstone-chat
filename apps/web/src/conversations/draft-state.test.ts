import type { DraftState } from "@capstone/protocol";
import { describe, expect, it } from "vitest";

import {
  acceptServerDraft,
  adoptRefreshedDraft,
  beginDraftSave,
  completeDraftSave,
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
