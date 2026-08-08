import type { DraftState } from "@capstone/protocol";

export type DraftSaveStatus = "conflict" | "saved" | "saving" | "unsaved";

export interface DraftRecord {
  readonly blocked: boolean;
  readonly conflict: DraftState | undefined;
  readonly content: string;
  readonly dirty: boolean;
  readonly editVersion: number;
  readonly lastAttemptedVersion: number;
  readonly revision: number;
  readonly status: DraftSaveStatus;
}

export interface ConfirmedDraftIdentity {
  readonly content: string;
  readonly editVersion: number;
  readonly revision: number;
}

export interface DraftConsumption {
  readonly canonical: DraftState;
  readonly record: DraftRecord;
}

export function initializeDraft(state: DraftState): DraftRecord {
  return {
    blocked: false,
    conflict: undefined,
    content: state.content,
    dirty: false,
    editVersion: 0,
    lastAttemptedVersion: -1,
    revision: state.revision,
    status: "saved",
  };
}

export function adoptRefreshedDraft(
  record: DraftRecord | undefined,
  state: DraftState,
): DraftRecord {
  if (
    record &&
    !record.dirty &&
    !record.blocked &&
    state.revision === record.revision &&
    state.content === record.content
  ) {
    return record;
  }
  if (!record || (!record.dirty && !record.blocked && state.revision >= record.revision)) {
    return initializeDraft(state);
  }

  return record;
}

export function editDraft(record: DraftRecord, content: string): DraftRecord {
  return {
    ...record,
    content,
    dirty: true,
    editVersion: record.editVersion + 1,
    status: record.blocked ? "conflict" : "unsaved",
  };
}

export function beginDraftSave(record: DraftRecord, version: number): DraftRecord {
  return {
    ...record,
    lastAttemptedVersion: version,
    status: "saving",
  };
}

export function completeDraftSave(
  current: DraftRecord,
  saved: DraftState,
  submittedContent: string,
  submittedVersion: number,
): DraftRecord {
  const hasNewerText =
    current.content !== submittedContent || current.editVersion !== submittedVersion;

  return {
    ...current,
    blocked: false,
    conflict: undefined,
    dirty: hasNewerText,
    lastAttemptedVersion: submittedVersion,
    revision: saved.revision,
    status: hasNewerText ? "unsaved" : "saved",
  };
}

export function consumeConfirmedDraft(
  current: DraftRecord | undefined,
  confirmed: ConfirmedDraftIdentity,
  empty: DraftState,
  cached: DraftState | undefined,
): DraftConsumption {
  if (
    !current ||
    (current.content === confirmed.content &&
      current.editVersion === confirmed.editVersion &&
      current.revision === confirmed.revision)
  ) {
    return { canonical: empty, record: initializeDraft(empty) };
  }

  const canonical =
    cached && (cached.content !== confirmed.content || cached.revision !== confirmed.revision)
      ? cached
      : empty;
  const canonicalIsConsumedEmpty =
    canonical.content === "" && canonical.revision === 0 && canonical.updatedAt === null;
  if (current.blocked && !canonicalIsConsumedEmpty) {
    return { canonical, record: markDraftConflict(current, canonical) };
  }
  if (current.dirty && !canonicalIsConsumedEmpty && canonical.revision !== current.revision) {
    return { canonical, record: markDraftConflict(current, canonical) };
  }
  if (!current.dirty) {
    const record =
      current.content === canonical.content && current.revision === canonical.revision
        ? current
        : initializeDraft(canonical);
    return { canonical, record };
  }

  return {
    canonical,
    record: {
      ...current,
      blocked: false,
      conflict: undefined,
      dirty: true,
      lastAttemptedVersion: current.editVersion - 1,
      revision: canonical.revision,
      status: "unsaved",
    },
  };
}

export function markDraftUnsaved(record: DraftRecord): DraftRecord {
  return { ...record, dirty: true, status: "unsaved" };
}

export function markDraftConflict(record: DraftRecord, server: DraftState): DraftRecord {
  return {
    ...record,
    blocked: true,
    conflict: server,
    dirty: true,
    revision: server.revision,
    status: "conflict",
  };
}

export function blockDraftAfterConflict(record: DraftRecord): DraftRecord {
  return {
    ...record,
    blocked: true,
    conflict: undefined,
    dirty: true,
    status: "conflict",
  };
}

export function acceptServerDraft(record: DraftRecord): DraftRecord {
  if (!record.conflict) {
    return record;
  }

  return initializeDraft(record.conflict);
}

export function prepareDraftReplacement(record: DraftRecord): DraftRecord {
  if (!record.conflict) {
    return record;
  }

  return {
    ...record,
    blocked: false,
    conflict: undefined,
    dirty: true,
    revision: record.conflict.revision,
    status: "unsaved",
  };
}
