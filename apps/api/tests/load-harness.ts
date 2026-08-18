import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  ApiErrorSchema,
  ConversationDetailResponseSchema,
  ConversationListResponseSchema,
  ConversationSearchResponseSchema,
  CreateConversationResponseSchema,
  DraftStateSchema,
  ResponseUpdatesResponseSchema,
  type StreamEvent,
  StreamEventSchema,
} from "@capstone/protocol";
import Value from "typebox/value";
import { bootstrapAssistantRulesInTransaction } from "../src/assistant-rules/service.js";
import { session as authenticationSessions, user } from "../src/database/auth-schema.generated.js";
import { createDatabase } from "../src/database/database.js";
import { createDatabasePool } from "../src/database/pool.js";
import { responseUpdatesTuning } from "../src/generations/response-updates.js";
import { createIdentityService } from "../src/identity/service.js";
import {
  BoundedNdjsonDecoder,
  diagnosticsAuthorization,
  hasMonotonicMemoryGrowth,
  type LoadOptions,
  maximumDurableUpdatePolls,
  parseLoadOptions,
  StreamLifecycleGuard,
} from "../src/load/harness-safety.js";
import {
  createLoadRehearsalCatalog,
  managedRehearsalAdministratorEmail,
} from "../src/load/managed-rehearsal.js";
import { createBudgetService } from "../src/model-policy/budget-service.js";
import { modelTiers, verifyPrivacyAttestation } from "../src/model-policy/catalog.js";
import { createModelPolicyService } from "../src/model-policy/service.js";
import { costControlTuning } from "../src/model-policy/settings.js";

const jsonRequestTimeoutMilliseconds = 15_000;
const maximumNdjsonLineBytes = 65_536;
const streamTimeoutMilliseconds = 2 * 60 * 1_000;
// Low-frequency admin, failure, rejection, and serializer paths tier up after roughly 6-9 full
// workload repetitions on Node 24. Ten unmeasured waves keep that finite V8 code generation out of
// the strict post-baseline leak signal without changing the measured workload or its gates.
const warmupWaveCount = 10;

type Scenario = "cancel" | "failure" | "large" | "normal" | "reattach" | "seed" | "slow";

interface LoadEmployee {
  readonly cookie: string;
  readonly index: number;
}

interface PreparedConversation {
  readonly conversationId: string;
  readonly conversationIndex: number;
  readonly draftRevision: number;
  readonly observedRevision: number;
  readonly parentMessageId: string | null;
  readonly scenario: Scenario;
}

interface PreparedWave {
  readonly conversations: readonly (readonly PreparedConversation[])[];
  readonly expectsCompaction: boolean;
  readonly wave: number;
}

const ordinaryOperationNames = [
  "admin-employees",
  "admin-model-policy",
  "admin-usage",
  "conversation-detail",
  "conversation-draft",
  "conversation-list",
  "conversation-search",
  "model-tiers",
  "readiness",
  "session",
] as const;

type OrdinaryOperationName = (typeof ordinaryOperationNames)[number];

interface OrdinaryMeasurement {
  readonly duration: number;
  readonly operation: OrdinaryOperationName;
}

interface StartedEvent {
  readonly conversationId: string;
  readonly generationId: string;
  readonly messageId: string;
  readonly revision: number;
}

interface StreamResult {
  readonly compacted: boolean;
  /** Durable update polls made after the deliberate mid-stream disconnect (reattach scenario). */
  readonly updatePolls: number;
  readonly conversationId: string;
  readonly conversationIndex: number;
  readonly employeeIndex: number;
  readonly firstDeltaAt: number | null;
  readonly responseStartedAt: number;
  readonly scenario: Scenario;
  readonly selectedLeafMessageId: string;
  readonly revision: number;
  readonly startedAt: number;
  readonly terminalAt: number;
  readonly terminalType: "response.cancelled" | "response.completed" | "response.failed";
  readonly wave: number;
}

interface DurablePollingResult {
  readonly conversationIndex: number;
  readonly durableUpdatePolls: number;
  readonly employeeIndex: number;
  readonly maximumDurableUpdatePolls: number;
  readonly reattachmentMilliseconds: number;
}

interface StreamControl {
  readonly firstDelta: Promise<void>;
  readonly result: Promise<StreamResult>;
  readonly started: Promise<StartedEvent>;
}

interface LoadDiagnosticsSnapshot {
  readonly baseline: { readonly heapUsedBytes: number; readonly rssBytes: number };
  readonly cpu: { readonly utilizationPercent: number };
  readonly current: { readonly heapUsedBytes: number; readonly rssBytes: number };
  readonly eventLoop: {
    readonly maximumDelayMilliseconds: number;
    readonly p99DelayMilliseconds: number;
  };
  readonly loadHarnessVersion: 1;
  readonly peak: { readonly heapUsedBytes: number; readonly rssBytes: number };
  readonly pool: {
    readonly idle: number;
    readonly peakWaiting: number;
    readonly total: number;
    readonly waiting: number;
  };
  readonly streams: { readonly active: number; readonly peakActive: number };
  readonly updates: { readonly active: number; readonly peakActive: number };
}

interface DatabaseState {
  readonly activeChatWorkflows: number;
  readonly activeCompactions: number;
  readonly activeTitles: number;
  readonly connections: number;
  readonly finalizingChatParents: number;
  readonly reservedChatAccounting: number;
  readonly reservedCompactionAccounting: number;
  readonly reservedTitleAccounting: number;
}

type DatabaseWorkPeaks = Omit<DatabaseState, "connections">;

class LoadMeasurementError extends Error {
  constructor(
    message: string,
    readonly failure: string,
    readonly measurements: Readonly<Record<string, number>>,
  ) {
    super(message);
    this.name = "LoadMeasurementError";
  }
}

function requiredEnvironment(
  name:
    | "CAPSTONE_LOAD_AUTH_SECRET"
    | "CAPSTONE_LOAD_DATABASE_URL"
    | "CAPSTONE_LOAD_DIAGNOSTICS_SECRET",
): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function loadOptions(): LoadOptions {
  return parseLoadOptions(process.argv.slice(2));
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1);
  return Number((ordered[index] ?? 0).toFixed(2));
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function loadDiagnosticsSnapshot(value: unknown): value is LoadDiagnosticsSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const snapshot = value as Partial<LoadDiagnosticsSnapshot>;
  return (
    nonnegativeNumber(snapshot.baseline?.heapUsedBytes) &&
    nonnegativeNumber(snapshot.baseline.rssBytes) &&
    nonnegativeNumber(snapshot.cpu?.utilizationPercent) &&
    nonnegativeNumber(snapshot.current?.heapUsedBytes) &&
    nonnegativeNumber(snapshot.current.rssBytes) &&
    nonnegativeNumber(snapshot.eventLoop?.maximumDelayMilliseconds) &&
    nonnegativeNumber(snapshot.eventLoop.p99DelayMilliseconds) &&
    snapshot.loadHarnessVersion === 1 &&
    nonnegativeNumber(snapshot.peak?.heapUsedBytes) &&
    nonnegativeNumber(snapshot.peak.rssBytes) &&
    nonnegativeNumber(snapshot.pool?.idle) &&
    nonnegativeNumber(snapshot.pool.peakWaiting) &&
    nonnegativeNumber(snapshot.pool.total) &&
    nonnegativeNumber(snapshot.pool.waiting) &&
    nonnegativeNumber(snapshot.streams?.active) &&
    nonnegativeNumber(snapshot.streams.peakActive) &&
    nonnegativeNumber(snapshot.updates?.active) &&
    nonnegativeNumber(snapshot.updates.peakActive)
  );
}

async function diagnosticsRequest(
  target: URL,
  action: "idle" | "read" | "reset",
  authorization: Readonly<Record<string, string>>,
): Promise<LoadDiagnosticsSnapshot> {
  const path =
    action === "read"
      ? "/__load/metrics"
      : action === "reset"
        ? "/__load/metrics/reset"
        : "/__load/metrics/idle";
  const mutation = action !== "read";
  const response = await fetch(new URL(path, target), {
    ...(mutation ? { body: "{}" } : {}),
    headers: {
      accept: "application/json",
      ...authorization,
      origin: target.origin,
      ...(mutation ? { "content-type": "application/json" } : {}),
    },
    method: mutation ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(jsonRequestTimeoutMilliseconds),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (response.status !== 200 || !loadDiagnosticsSnapshot(payload)) {
    throw new Error("The isolated load target did not provide bounded process diagnostics");
  }
  return payload;
}

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function assertEmptyLoadDatabase(databaseUrl: string): Promise<void> {
  const pool = createDatabasePool(databaseUrl);
  try {
    const tables = await pool.query<{
      readonly schema_name: string;
      readonly table_name: string;
    }>(`
      SELECT namespace.nspname AS schema_name, relation.relname AS table_name
      FROM pg_class AS relation
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND relation.relname <> '__drizzle_migrations'
      ORDER BY namespace.nspname, relation.relname
    `);
    for (const table of tables.rows) {
      const relation = `${quotePostgresIdentifier(table.schema_name)}.${quotePostgresIdentifier(table.table_name)}`;
      const occupied = await pool.query<{ readonly occupied: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${relation} LIMIT 1) AS occupied`,
      );
      if (occupied.rows[0]?.occupied !== false) {
        throw new Error("The isolated load database must be empty before fixture setup");
      }
    }
  } finally {
    await pool.end();
  }
}

async function assertManagedRehearsalBaseline(databaseUrl: string): Promise<Date> {
  const pool = createDatabasePool(databaseUrl);
  try {
    const result = await pool.query<{
      readonly approval_count: string;
      readonly catalog_count: string;
      readonly initialized: boolean;
      readonly privacy_verified_at: Date;
      readonly user_count: string;
      readonly workspace_count: string;
    }>(`
      SELECT
        (SELECT count(*) FROM "employee_approvals")::text AS approval_count,
        (SELECT count(*) FROM "model_catalog" WHERE "metadata_source" = 'openrouter')::text AS catalog_count,
        EXISTS (
          SELECT 1 FROM "production_initialization"
          WHERE "singleton_id" = 1 AND "phase" = 'complete'
        ) AS initialized,
        (SELECT "verified_at" FROM "openrouter_privacy_attestations" LIMIT 1) AS privacy_verified_at,
        (SELECT count(*) FROM "user")::text AS user_count,
        (SELECT count(*) FROM "workspaces")::text AS workspace_count
    `);
    const row = result.rows[0];
    if (
      row === undefined ||
      row.initialized !== true ||
      row.workspace_count !== "1" ||
      row.approval_count !== "1" ||
      row.catalog_count !== "3" ||
      row.user_count !== "0" ||
      !(row.privacy_verified_at instanceof Date) ||
      !Number.isFinite(row.privacy_verified_at.getTime())
    ) {
      throw new Error(
        "The managed rehearsal database did not match its initialized clean baseline",
      );
    }
    return row.privacy_verified_at;
  } finally {
    await pool.end();
  }
}

async function verifyTargetDatabase(
  target: URL,
  databaseUrl: string,
  authorization: Readonly<Record<string, string>>,
): Promise<void> {
  const first = randomBytes(4).readInt32BE();
  const second = randomBytes(4).readInt32BE();
  const pool = createDatabasePool(databaseUrl);
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [first, second]);
      try {
        const response = await fetch(new URL("/__load/database-challenge", target), {
          body: JSON.stringify({ first, second }),
          headers: {
            accept: "application/json",
            ...authorization,
            "content-type": "application/json",
            origin: target.origin,
          },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(jsonRequestTimeoutMilliseconds),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (
          response.status !== 200 ||
          typeof payload !== "object" ||
          payload === null ||
          (payload as { readonly loadHarnessVersion?: unknown }).loadHarnessVersion !== 1 ||
          (payload as { readonly matched?: unknown }).matched !== true
        ) {
          throw new Error("The load target and fixture database did not match");
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [first, second]);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function signedSessionCookie(secret: string, token: string): string {
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function bootstrapEmployees(
  databaseUrl: string,
  authSecret: string,
  employeeCount: number,
  managedRehearsal: boolean,
  validatedAt = new Date(),
): Promise<readonly LoadEmployee[]> {
  const pool = createDatabasePool(databaseUrl);
  const database = createDatabase(pool);
  try {
    const identity = createIdentityService(database);
    const modelPolicy = createModelPolicyService(database);
    const bootstrap = await identity.bootstrap({
      adminEmail: managedRehearsal ? managedRehearsalAdministratorEmail : "load-00@example.test",
      displayName: managedRehearsal ? "Capstone" : "Capstone Load Rehearsal",
      workspaceIdentity: managedRehearsal ? "capstone" : "capstone-load",
    });
    if (!managedRehearsal) {
      await database.transaction((transaction) =>
        bootstrapAssistantRulesInTransaction(transaction, bootstrap.workspaceId, new Date()),
      );
    }
    const output = { balanced: 8_192, fast: 4_096, pro: 16_384 } as const;
    await modelPolicy.bootstrap({
      catalog: createLoadRehearsalCatalog(validatedAt),
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: output,
      mode: "openrouter",
      monthlyBudgetUsd: "100",
      privacyAttestation: verifyPrivacyAttestation({
        attestationVersion: "openrouter-privacy-v1",
        broadcastEnabled: false,
        dataDiscountLoggingEnabled: false,
        inputOutputLoggingEnabled: false,
        verifiedAt: validatedAt,
      }),
      reservationMarginBasisPoints: 2_000,
      workspaceIdentity: managedRehearsal ? "capstone" : "capstone-load",
    });

    const employees: LoadEmployee[] = [];
    for (let index = 0; index < employeeCount; index += 1) {
      const email =
        managedRehearsal && index === 0
          ? managedRehearsalAdministratorEmail
          : `load-${index.toString().padStart(2, "0")}@example.test`;
      if (index > 0) {
        await identity.approve({
          email,
          role: "member",
          workspaceIdentity: managedRehearsal ? "capstone" : "capstone-load",
        });
      }
      const userId = randomUUID();
      const identityUser = { email, emailVerified: true, id: userId };
      const timestamp = new Date();
      await database.insert(user).values({
        createdAt: timestamp,
        email,
        emailVerified: true,
        id: userId,
        name: `Empleado sintético ${index + 1}`,
        updatedAt: timestamp,
      });
      await identity.linkRegisteredUser(identityUser);
      const activation = await identity.activateMembership(identityUser);
      if (activation !== "activated") {
        throw new Error("A synthetic load employee could not be activated");
      }
      const token = randomUUID();
      await database.insert(authenticationSessions).values({
        createdAt: timestamp,
        expiresAt: new Date(timestamp.getTime() + 60 * 60 * 1_000),
        id: randomUUID(),
        token,
        updatedAt: timestamp,
        userId,
      });
      employees.push({ cookie: signedSessionCookie(authSecret, token), index });
    }
    if (bootstrap.workspaceId.length === 0 || modelTiers.length !== 3) {
      throw new Error("The synthetic load policy was incomplete");
    }
    return employees;
  } finally {
    await pool.end();
  }
}

function requestHeaders(target: URL, employee: LoadEmployee, accept = "application/json") {
  return {
    accept,
    cookie: employee.cookie,
    origin: target.origin,
  };
}

async function jsonRequest(
  target: URL,
  employee: LoadEmployee,
  path: string,
  method: "GET" | "POST" | "PUT",
  body?: unknown,
): Promise<{ readonly duration: number; readonly payload: unknown; readonly status: number }> {
  const startedAt = performance.now();
  const response = await fetch(new URL(path, target), {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...requestHeaders(target, employee),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    method,
    redirect: "error",
    signal: AbortSignal.timeout(jsonRequestTimeoutMilliseconds),
  });
  const payload = response.status === 204 ? null : await response.json();
  return { duration: performance.now() - startedAt, payload, status: response.status };
}

async function rejectedStreamRequest(
  target: URL,
  employee: LoadEmployee,
  conversationId: string,
  body: unknown,
): Promise<{ readonly payload: unknown; readonly status: number }> {
  const response = await fetch(new URL(`/api/conversations/${conversationId}/responses`, target), {
    body: JSON.stringify(body),
    headers: {
      ...requestHeaders(target, employee, "application/x-ndjson"),
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(jsonRequestTimeoutMilliseconds),
  });
  return { payload: await response.json(), status: response.status };
}

async function createConversation(target: URL, employee: LoadEmployee): Promise<string> {
  const response = await jsonRequest(target, employee, "/api/conversations", "POST", {});
  if (response.status !== 201 || !Value.Check(CreateConversationResponseSchema, response.payload)) {
    throw new Error("A synthetic conversation could not be created");
  }
  return response.payload.id;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function syntheticMessage(
  runId: string,
  wave: number,
  employeeIndex: number,
  conversationIndex: number,
  scenario: Scenario,
): string {
  return `CAPSTONE_LOAD_V1:${runId}:${wave}:${employeeIndex}:${conversationIndex}:${scenario}`;
}

function startStream(input: {
  readonly conversationId: string;
  readonly conversationIndex: number;
  readonly employee: LoadEmployee;
  readonly observedRevision?: number;
  readonly parentMessageId?: string | null;
  readonly preparedDraftRevision?: number;
  readonly runId: string;
  readonly scenario: Scenario;
  readonly target: URL;
  readonly wave: number;
}): StreamControl {
  const startedSignal = deferred<StartedEvent>();
  const firstDeltaSignal = deferred<void>();
  let firstDeltaResolved = false;
  const result = (async (): Promise<StreamResult> => {
    const streamController = new AbortController();
    const message = syntheticMessage(
      input.runId,
      input.wave,
      input.employee.index,
      input.conversationIndex,
      input.scenario,
    );
    const expectedCanary = `LOAD_RESPONSE:${input.runId}:${input.wave}:${input.employee.index}:${input.conversationIndex}`;
    let draftRevision = input.preparedDraftRevision;
    if (draftRevision === undefined) {
      const draft = await jsonRequest(
        input.target,
        input.employee,
        `/api/conversations/${input.conversationId}/draft`,
        "PUT",
        { content: message, observedRevision: 0 },
      );
      if (draft.status !== 200 || !Value.Check(DraftStateSchema, draft.payload)) {
        throw new Error("A synthetic response draft could not be persisted");
      }
      draftRevision = draft.payload.revision;
    }
    const startedAt = performance.now();
    const response = await fetch(
      new URL(`/api/conversations/${input.conversationId}/responses`, input.target),
      {
        body: JSON.stringify({
          content: [
            {
              text: message,
              type: "text",
            },
          ],
          draftRevision,
          modelTier: "balanced",
          observedRevision: input.observedRevision ?? 0,
          parentMessageId: input.parentMessageId ?? null,
          source: "draft",
        }),
        headers: {
          ...requestHeaders(input.target, input.employee, "application/x-ndjson"),
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([
          streamController.signal,
          AbortSignal.timeout(streamTimeoutMilliseconds),
        ]),
      },
    );
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const code = Value.Check(ApiErrorSchema, payload) ? payload.code : "INVALID_ERROR_RESPONSE";
      throw new Error(`A synthetic response stream did not start (${response.status} ${code})`);
    }
    if (response.body === null) {
      throw new Error("A synthetic response stream did not return a body");
    }
    const reader = response.body.getReader();
    const decoder = new BoundedNdjsonDecoder(maximumNdjsonLineBytes);
    const lifecycle = new StreamLifecycleGuard();
    let responseStartedAt = 0;
    let firstDeltaAt: number | null = null;
    let terminalType: StreamResult["terminalType"] | undefined;
    let terminalMessageId: string | undefined;
    let terminalRevision: number | undefined;
    let startedMessageId: string | undefined;
    let sawStarted = false;
    let compacted = false;
    let reattachAfterDelta = false;
    let updatePolls = 0;
    try {
      while (true) {
        if (reattachAfterDelta) {
          break;
        }
        const read = await reader.read();
        const lines = decoder.push(read.value, read.done);
        for (const line of lines) {
          const parsed: unknown = JSON.parse(line);
          if (!Value.Check(StreamEventSchema, parsed)) {
            throw new Error("A synthetic stream emitted an invalid NDJSON event");
          }
          const event = parsed as StreamEvent;
          lifecycle.accept(event.type);
          if (event.type === "response.started") {
            sawStarted = true;
            startedMessageId = event.messageId;
            responseStartedAt = performance.now();
            startedSignal.resolve(event);
            continue;
          }
          if (event.type === "context.compacted") {
            compacted = true;
          }
          if (event.type === "content.delta" && firstDeltaAt === null) {
            firstDeltaAt = performance.now();
            firstDeltaResolved = true;
            firstDeltaSignal.resolve();
            if (input.scenario === "reattach") {
              reattachAfterDelta = true;
            }
          }
          if (
            event.type === "content.delta" &&
            (!event.text.startsWith(`${expectedCanary}:`) ||
              event.text.slice(expectedCanary.length + 1).includes("LOAD_RESPONSE:"))
          ) {
            throw new Error("Synthetic response data crossed an employee boundary");
          }
          if (
            event.type === "response.cancelled" ||
            event.type === "response.completed" ||
            event.type === "response.failed"
          ) {
            terminalType = event.type;
            terminalMessageId = event.messageId;
            terminalRevision = event.revision;
          }
          if (input.scenario === "slow") {
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
        }
        if (read.done) {
          break;
        }
      }
    } catch (error: unknown) {
      streamController.abort(error);
      await reader.cancel(error).catch(() => undefined);
      startedSignal.reject(error);
      if (!firstDeltaResolved) {
        firstDeltaSignal.reject(error);
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (reattachAfterDelta && startedMessageId !== undefined) {
      // Deliberate downstream loss: the socket closes, the generation must keep producing, and
      // the same generation is followed through the durable updates endpoint until terminal.
      streamController.abort(new DOMException("Synthetic disconnect", "AbortError"));
      const generationId = (await startedSignal.promise).generationId;
      let cursor: string | null = null;
      let durableText = "";
      while (terminalType === undefined) {
        const poll = await fetch(
          new URL(
            `/api/conversations/${input.conversationId}/responses/${generationId}/updates`,
            input.target,
          ),
          {
            body: JSON.stringify({ cursor }),
            headers: {
              ...requestHeaders(input.target, input.employee),
              "content-type": "application/json",
            },
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(streamTimeoutMilliseconds),
          },
        );
        updatePolls += 1;
        const payload: unknown = await poll.json().catch(() => null);
        if (poll.status !== 200 || !Value.Check(ResponseUpdatesResponseSchema, payload)) {
          throw new Error(`A durable update poll failed (${poll.status})`);
        }
        if (payload.response.messageId !== startedMessageId) {
          throw new Error("A durable update referenced a different message");
        }
        durableText =
          payload.content.mode === "replace"
            ? payload.content.text
            : durableText + payload.content.text;
        const foreign = durableText
          .split("LOAD_RESPONSE:")
          .slice(1)
          .some((segment) => !`LOAD_RESPONSE:${segment}`.startsWith(`${expectedCanary}:`));
        if (foreign) {
          throw new Error("Durable update data crossed an employee boundary");
        }
        if (payload.response.status !== "active") {
          terminalType =
            payload.response.status === "completed"
              ? "response.completed"
              : payload.response.status === "cancelled"
                ? "response.cancelled"
                : "response.failed";
          terminalMessageId = payload.response.messageId;
          terminalRevision = payload.revision;
          if (payload.nextCursor !== null) {
            throw new Error("A terminal durable update still offered a cursor");
          }
          break;
        }
        if (payload.nextCursor === null) {
          throw new Error("An active durable update ended without a cursor");
        }
        cursor = payload.nextCursor;
      }
    } else {
      lifecycle.finish();
    }
    if (
      !sawStarted ||
      terminalType === undefined ||
      terminalMessageId === undefined ||
      terminalMessageId !== startedMessageId ||
      terminalRevision === undefined
    ) {
      throw new Error("A synthetic stream terminal event was incomplete");
    }
    if (!firstDeltaResolved) {
      firstDeltaResolved = true;
      firstDeltaSignal.resolve();
    }
    return {
      compacted,
      conversationId: input.conversationId,
      conversationIndex: input.conversationIndex,
      employeeIndex: input.employee.index,
      firstDeltaAt,
      updatePolls,
      responseStartedAt,
      revision: terminalRevision,
      scenario: input.scenario,
      selectedLeafMessageId: terminalMessageId,
      startedAt,
      terminalAt: performance.now(),
      terminalType,
      wave: input.wave,
    };
  })();
  void result.catch((error: unknown) => {
    startedSignal.reject(error);
    if (!firstDeltaResolved) {
      firstDeltaSignal.reject(error);
    }
  });
  return { firstDelta: firstDeltaSignal.promise, result, started: startedSignal.promise };
}

async function prepareCompactionSeed(
  target: URL,
  employee: LoadEmployee,
  runId: string,
): Promise<{
  readonly conversationId: string;
  readonly parentMessageId: string;
  readonly revision: number;
}> {
  const conversationId = await createConversation(target, employee);
  let prepared = await startStream({
    conversationId,
    conversationIndex: 9,
    employee,
    runId,
    scenario: "large",
    target,
    wave: 0,
  }).result;
  if (prepared.terminalType !== "response.completed") {
    throw new Error("The compaction fixture could not create its large selected branch");
  }
  for (let turn = 0; turn < 8; turn += 1) {
    prepared = await startStream({
      conversationId,
      conversationIndex: 8,
      employee,
      observedRevision: prepared.revision,
      parentMessageId: prepared.selectedLeafMessageId,
      runId,
      scenario: "seed",
      target,
      wave: 0,
    }).result;
    if (prepared.terminalType !== "response.completed") {
      throw new Error("The compaction fixture could not create its bounded recent turns");
    }
  }
  return {
    conversationId,
    parentMessageId: prepared.selectedLeafMessageId,
    revision: prepared.revision,
  };
}

function measuredScenario(employeeIndex: number, conversationIndex: number): Scenario {
  if (employeeIndex % 5 === 1 && conversationIndex === 0) {
    return "cancel";
  }
  if (employeeIndex === 2 && conversationIndex === 0) {
    return "failure";
  }
  if (employeeIndex === 3 && conversationIndex === 1) {
    return "slow";
  }
  // Roughly half of the measured streams disconnect after their first delta and follow the same
  // generation through durable updates instead of the NDJSON transport.
  return conversationIndex === 1 ? "reattach" : "normal";
}

async function prepareConversationFixture(input: {
  readonly branch?: {
    readonly conversationId: string;
    readonly parentMessageId: string | null;
    readonly revision: number;
  };
  readonly conversationIndex: number;
  readonly employee: LoadEmployee;
  readonly runId: string;
  readonly seedHistory?: boolean;
  readonly target: URL;
  readonly wave: number;
}): Promise<PreparedConversation> {
  let branch = input.branch;
  if (branch === undefined) {
    const conversationId = await createConversation(input.target, input.employee);
    if (input.seedHistory === false) {
      branch = { conversationId, parentMessageId: null, revision: 0 };
    } else {
      const seeded = await startStream({
        conversationId,
        conversationIndex: input.conversationIndex,
        employee: input.employee,
        runId: input.runId,
        scenario: "seed",
        target: input.target,
        wave: 0,
      }).result;
      if (seeded.terminalType !== "response.completed") {
        throw new Error("A synthetic conversation history could not be prepared");
      }
      branch = {
        conversationId,
        parentMessageId: seeded.selectedLeafMessageId,
        revision: seeded.revision,
      };
    }
  }
  const scenario = measuredScenario(input.employee.index, input.conversationIndex);
  const draft = await jsonRequest(
    input.target,
    input.employee,
    `/api/conversations/${branch.conversationId}/draft`,
    "PUT",
    {
      content: syntheticMessage(
        input.runId,
        input.wave,
        input.employee.index,
        input.conversationIndex,
        scenario,
      ),
      observedRevision: 0,
    },
  );
  if (draft.status !== 200 || !Value.Check(DraftStateSchema, draft.payload)) {
    throw new Error("A synthetic response draft could not be prepared");
  }
  return {
    conversationId: branch.conversationId,
    conversationIndex: input.conversationIndex,
    draftRevision: draft.payload.revision,
    observedRevision: branch.revision,
    parentMessageId: branch.parentMessageId,
    scenario,
  };
}

async function prepareWaveFixtures(
  target: URL,
  employees: readonly LoadEmployee[],
  runId: string,
  wave: number,
  compactionSeed?: {
    readonly conversationId: string;
    readonly parentMessageId: string;
    readonly revision: number;
  },
): Promise<PreparedWave> {
  const conversations = await Promise.all(
    employees.map(async (employee) => {
      const firstTwo = await Promise.all(
        [0, 1].map((conversationIndex) =>
          prepareConversationFixture({
            ...(employee.index === 3 && conversationIndex === 0 && compactionSeed !== undefined
              ? { branch: compactionSeed }
              : {}),
            conversationIndex,
            employee,
            runId,
            seedHistory: conversationIndex === 0 && employee.index % 2 === 0,
            target,
            wave,
          }),
        ),
      );
      if (employee.index !== 0) {
        return firstTwo;
      }
      return [
        ...firstTwo,
        await prepareConversationFixture({
          conversationIndex: 2,
          employee,
          runId,
          target,
          wave,
        }),
      ];
    }),
  );
  return { conversations, expectsCompaction: compactionSeed !== undefined, wave };
}

async function expectApiError(
  response: { readonly payload: unknown; readonly status: number },
  status: number,
  code: "EMPLOYEE_GENERATION_LIMIT_REACHED" | "GENERATION_ACTIVE",
): Promise<void> {
  if (
    response.status !== status ||
    !Value.Check(ApiErrorSchema, response.payload) ||
    response.payload.code !== code
  ) {
    throw new Error("A concurrency rejection did not match the approved stable error");
  }
}

async function verifyIsolation(
  target: URL,
  employee: LoadEmployee,
  runId: string,
  result: StreamResult,
  employeeCount: number,
): Promise<void> {
  const response = await jsonRequest(
    target,
    employee,
    `/api/conversations/${result.conversationId}`,
    "GET",
  );
  if (response.status !== 200 || !Value.Check(ConversationDetailResponseSchema, response.payload)) {
    throw new Error("A synthetic conversation could not be read after its stream");
  }
  const serialized = JSON.stringify(response.payload);
  verifySerializedIsolation(serialized, runId, employee.index, employeeCount);
  if (
    !serialized.includes(
      `LOAD_RESPONSE:${runId}:${result.wave}:${employee.index}:${result.conversationIndex}:`,
    )
  ) {
    throw new Error("A canonical response did not retain its exact synthetic canary");
  }
}

function verifySerializedIsolation(
  serialized: string,
  runId: string,
  employeeIndex: number,
  employeeCount: number,
): void {
  for (let index = 0; index < employeeCount; index += 1) {
    if (index !== employeeIndex) {
      for (const prefix of ["CAPSTONE_LOAD_V1", "LOAD_RESPONSE"]) {
        for (let wave = 0; wave <= 5; wave += 1) {
          if (serialized.includes(`${prefix}:${runId}:${wave}:${index}:`)) {
            throw new Error("Synthetic response data crossed an employee boundary");
          }
        }
      }
    }
  }
}

function durablePollingResults(
  streamResults: readonly StreamResult[],
): readonly DurablePollingResult[] {
  const measurements: DurablePollingResult[] = [];
  for (const result of streamResults) {
    if (result.scenario !== "reattach") {
      if (result.updatePolls !== 0) {
        throw new LoadMeasurementError(
          "A direct stream unexpectedly used durable updates",
          "durable-updates-unexpected",
          {
            conversationIndex: result.conversationIndex,
            durableUpdatePolls: result.updatePolls,
            employeeIndex: result.employeeIndex,
            wave: result.wave,
          },
        );
      }
      continue;
    }
    const reattachmentMilliseconds =
      result.firstDeltaAt === null ? 0 : Math.max(0, result.terminalAt - result.firstDeltaAt);
    const maximumPolls = maximumDurableUpdatePolls(
      reattachmentMilliseconds,
      responseUpdatesTuning.pollIntervalMilliseconds,
    );
    const evidence = {
      conversationIndex: result.conversationIndex,
      durableUpdatePolls: result.updatePolls,
      employeeIndex: result.employeeIndex,
      maximumDurableUpdatePolls: maximumPolls,
      reattachmentMilliseconds: Number(reattachmentMilliseconds.toFixed(2)),
      wave: result.wave,
    };
    if (result.firstDeltaAt === null || result.updatePolls === 0) {
      throw new LoadMeasurementError(
        "A reattached stream did not use durable updates",
        "durable-updates-missing",
        evidence,
      );
    }
    if (result.updatePolls > maximumPolls) {
      throw new LoadMeasurementError(
        "A reattached stream exceeded the durable polling cadence",
        "durable-updates-hot-polling",
        evidence,
      );
    }
    measurements.push(evidence);
  }
  return measurements;
}

async function runWave(
  target: URL,
  employees: readonly LoadEmployee[],
  databaseUrl: string,
  runId: string,
  fixture: PreparedWave,
  diagnosticsHeaders: Readonly<Record<string, string>>,
): Promise<{
  readonly apiMeasurements: readonly OrdinaryMeasurement[];
  readonly cancellationMilliseconds: readonly number[];
  readonly durablePolling: readonly DurablePollingResult[];
  readonly peakActiveChatWorkflows: number;
  readonly peakActiveCompactions: number;
  readonly peakActiveTitles: number;
  readonly peakActiveStreams: number;
  readonly peakFinalizingChatParents: number;
  readonly peakReservedChatAccounting: number;
  readonly peakReservedCompactionAccounting: number;
  readonly peakReservedTitleAccounting: number;
  readonly reconciliation: {
    readonly inspected: number;
    readonly settled: number;
    readonly terminalized: number;
  };
  readonly streamResults: readonly StreamResult[];
}> {
  const wave = fixture.wave;
  const controls: StreamControl[] = [];
  for (const employee of employees) {
    for (let conversationIndex = 0; conversationIndex < 2; conversationIndex += 1) {
      const prepared = fixture.conversations[employee.index]?.[conversationIndex];
      if (prepared === undefined || prepared.conversationIndex !== conversationIndex) {
        throw new Error("A synthetic conversation fixture is missing");
      }
      controls.push(
        startStream({
          conversationId: prepared.conversationId,
          conversationIndex,
          employee,
          observedRevision: prepared.observedRevision,
          parentMessageId: prepared.parentMessageId,
          preparedDraftRevision: prepared.draftRevision,
          runId,
          scenario: prepared.scenario,
          target,
          wave,
        }),
      );
    }
  }

  const starts = await Promise.all(controls.map(({ started }) => started));
  const peakState = await databaseState(databaseUrl);
  const peakDiagnostics = await diagnosticsRequest(target, "read", diagnosticsHeaders);
  if (
    peakState.activeChatWorkflows !== employees.length * 2 ||
    peakState.reservedChatAccounting !== employees.length * 2 ||
    peakState.activeCompactions > 1 ||
    peakState.reservedCompactionAccounting > 1 ||
    peakDiagnostics.streams.active !== employees.length * 2
  ) {
    throw new Error("The measured wave did not reach its declared active-stream concurrency");
  }
  const ordinaryTraffic = employees.map(async (employee) => {
    const conversation = fixture.conversations[employee.index]?.[0];
    if (conversation === undefined) {
      throw new Error("The ordinary-traffic fixture was incomplete");
    }
    await pause(employee.index * 75);
    const operations: readonly {
      readonly name: OrdinaryOperationName;
      readonly run: () => ReturnType<typeof jsonRequest>;
    }[] = [
      { name: "session", run: () => jsonRequest(target, employee, "/api/session", "GET") },
      {
        name: "conversation-list",
        run: () => jsonRequest(target, employee, "/api/conversations?view=active", "GET"),
      },
      {
        name: "conversation-detail",
        run: () =>
          jsonRequest(target, employee, `/api/conversations/${conversation.conversationId}`, "GET"),
      },
      {
        name: "model-tiers",
        run: () => jsonRequest(target, employee, "/api/model-tiers", "GET"),
      },
      {
        name: "readiness",
        run: () => jsonRequest(target, employee, "/api/health/ready", "GET"),
      },
      {
        name: "conversation-search",
        run: () =>
          jsonRequest(target, employee, "/api/conversations/search", "POST", {
            query: "CAPSTONE_LOAD_V1",
          }),
      },
      {
        name: "conversation-draft",
        run: () =>
          jsonRequest(
            target,
            employee,
            `/api/conversations/${conversation.conversationId}/draft`,
            "PUT",
            {
              content: `Borrador sintético ${runId}:${employee.index}`,
              observedRevision: 0,
            },
          ),
      },
    ];
    const responses = [];
    for (const operation of operations) {
      const response = await operation.run();
      if (
        (operation.name === "conversation-list" &&
          !Value.Check(ConversationListResponseSchema, response.payload)) ||
        (operation.name === "conversation-search" &&
          !Value.Check(ConversationSearchResponseSchema, response.payload)) ||
        (operation.name === "conversation-detail" &&
          !Value.Check(ConversationDetailResponseSchema, response.payload))
      ) {
        throw new Error("Representative ordinary traffic returned an invalid payload");
      }
      if (
        operation.name === "conversation-detail" ||
        operation.name === "conversation-list" ||
        operation.name === "conversation-search"
      ) {
        verifySerializedIsolation(
          JSON.stringify(response.payload),
          runId,
          employee.index,
          employees.length,
        );
      }
      responses.push({ ...response, operation: operation.name });
      await pause(25);
    }
    return responses;
  });
  const administrator = employees[0];
  if (administrator === undefined) {
    throw new Error("The administrator fixture was incomplete");
  }
  ordinaryTraffic.push(
    (async () => {
      await pause(500);
      const responses = [];
      const operations = [
        { name: "admin-employees", path: "/api/admin/employees" },
        { name: "admin-model-policy", path: "/api/admin/model-policy" },
        { name: "admin-usage", path: "/api/admin/usage" },
      ] as const;
      for (const operation of operations) {
        responses.push({
          ...(await jsonRequest(target, administrator, operation.path, "GET")),
          operation: operation.name,
        });
        await pause(50);
      }
      return responses;
    })(),
  );

  const firstEmployeeStarts = [starts[0], starts[1]];
  const firstEmployee = employees[0];
  const thirdConversation = fixture.conversations[0]?.[2];
  const firstConversation = fixture.conversations[0]?.[0];
  const firstStarted = firstEmployeeStarts[0];
  if (!firstEmployee || !thirdConversation || !firstConversation || !firstStarted) {
    throw new Error("The concurrency fixture was incomplete");
  }
  const probeConversationIds = [firstConversation.conversationId, thirdConversation.conversationId];
  const beforeRejections = await conversationSideEffectState(databaseUrl, probeConversationIds);
  const limitProbeMessage = syntheticMessage(runId, wave, 0, 2, "normal");
  await expectApiError(
    await rejectedStreamRequest(target, firstEmployee, thirdConversation.conversationId, {
      content: [{ text: limitProbeMessage, type: "text" }],
      draftRevision: thirdConversation.draftRevision,
      modelTier: "balanced",
      observedRevision: thirdConversation.observedRevision,
      parentMessageId: thirdConversation.parentMessageId,
      source: "draft",
    }),
    409,
    "EMPLOYEE_GENERATION_LIMIT_REACHED",
  );
  await expectApiError(
    await rejectedStreamRequest(target, firstEmployee, firstConversation.conversationId, {
      content: [{ text: syntheticMessage(runId, wave, 0, 0, "normal"), type: "text" }],
      draftRevision: 0,
      modelTier: "balanced",
      observedRevision: firstStarted.revision,
      parentMessageId: firstStarted.messageId,
      source: "draft",
    }),
    409,
    "GENERATION_ACTIVE",
  );
  const afterRejections = await conversationSideEffectState(databaseUrl, probeConversationIds);
  if (JSON.stringify(afterRejections) !== JSON.stringify(beforeRejections)) {
    throw new Error("A concurrency rejection changed branch or budget state");
  }

  const cancellationSamples = employees
    .filter(({ index }) => measuredScenario(index, 0) === "cancel")
    .map((employee) => ({
      control: controls[employee.index * 2],
      employee,
      started: starts[employee.index * 2],
    }));
  if (
    cancellationSamples.some(({ control, employee, started }) => !control || !employee || !started)
  ) {
    throw new Error("The cancellation fixture was incomplete");
  }
  await Promise.all(
    cancellationSamples.map(({ control }) => {
      if (!control) {
        throw new Error("The cancellation fixture was incomplete");
      }
      return control.firstDelta;
    }),
  );
  const cancellationRequests = await Promise.all(
    cancellationSamples.map(async ({ employee, started }) => {
      if (!employee || !started) {
        throw new Error("The cancellation fixture was incomplete");
      }
      const requestedAt = performance.now();
      const response = await jsonRequest(
        target,
        employee,
        `/api/conversations/${started.conversationId}/responses/${started.generationId}/cancel`,
        "POST",
        {},
      );
      if (response.status !== 204) {
        throw new Error("The synthetic cancellation was rejected");
      }
      return { employeeIndex: employee.index, requestedAt };
    }),
  );

  const {
    peaks: sampledPeakState,
    result: [streamResults, groupedReads],
  } = await withDatabaseWorkSampling(databaseUrl, peakState, () =>
    Promise.all([
      Promise.all(controls.map(({ result }) => result)),
      Promise.all(ordinaryTraffic),
    ] as const),
  );
  if (
    sampledPeakState.finalizingChatParents === 0 ||
    sampledPeakState.activeTitles === 0 ||
    sampledPeakState.reservedTitleAccounting === 0
  ) {
    throw new LoadMeasurementError(
      "The measured wave did not exercise the durable naming lifecycle",
      "durable-naming-lifecycle-missing",
      {
        peakActiveTitles: sampledPeakState.activeTitles,
        peakFinalizingChatParents: sampledPeakState.finalizingChatParents,
        peakReservedTitleAccounting: sampledPeakState.reservedTitleAccounting,
      },
    );
  }
  const reads = groupedReads.flat();
  if (reads.some(({ status }) => status !== 200)) {
    throw new Error("Representative ordinary traffic returned an unexpected status");
  }
  const cancelled = streamResults.filter(({ scenario }) => scenario === "cancel");
  if (
    cancelled.length !== cancellationSamples.length ||
    cancelled.some(({ terminalType }) => terminalType !== "response.cancelled")
  ) {
    throw new Error("The cancellation stream did not terminalize as cancelled");
  }
  const failed = streamResults.find(({ scenario }) => scenario === "failure");
  if (failed?.terminalType !== "response.failed") {
    throw new Error("The failure stream did not terminalize as failed");
  }
  if (
    streamResults.some(
      ({ scenario, terminalType }) =>
        scenario !== "failure" && scenario !== "cancel" && terminalType !== "response.completed",
    )
  ) {
    throw new Error("A successful synthetic stream did not complete");
  }
  if (fixture.expectsCompaction && !streamResults.some(({ compacted }) => compacted)) {
    throw new Error("The prepared long branch did not exercise hidden context compaction");
  }
  const durablePolling = durablePollingResults(streamResults);
  const reconciliation = await reconcileExpiredReservations(databaseUrl);
  if (
    reconciliation.inspected !== 1 ||
    reconciliation.settled !== 1 ||
    reconciliation.terminalized !== 0
  ) {
    throw new Error("The measured wave did not reconcile its controlled reservation");
  }

  await Promise.all(
    streamResults.map((result) => {
      const employee = employees[result.employeeIndex];
      if (!employee) {
        throw new Error("A stream result referenced an unknown employee");
      }
      return verifyIsolation(target, employee, runId, result, employees.length);
    }),
  );
  return {
    apiMeasurements: reads.map(({ duration, operation }) => ({ duration, operation })),
    cancellationMilliseconds: cancellationRequests.map(({ employeeIndex, requestedAt }) => {
      const result = cancelled.find((candidate) => candidate.employeeIndex === employeeIndex);
      if (!result) {
        throw new Error("The cancellation fixture was incomplete");
      }
      return result.terminalAt - requestedAt;
    }),
    durablePolling,
    peakActiveChatWorkflows: sampledPeakState.activeChatWorkflows,
    peakActiveCompactions: sampledPeakState.activeCompactions,
    peakActiveTitles: sampledPeakState.activeTitles,
    peakActiveStreams: peakDiagnostics.streams.active,
    peakFinalizingChatParents: sampledPeakState.finalizingChatParents,
    peakReservedChatAccounting: sampledPeakState.reservedChatAccounting,
    peakReservedCompactionAccounting: sampledPeakState.reservedCompactionAccounting,
    peakReservedTitleAccounting: sampledPeakState.reservedTitleAccounting,
    reconciliation,
    streamResults,
  };
}

async function conversationSideEffectState(
  databaseUrl: string,
  conversationIds: readonly string[],
): Promise<readonly unknown[]> {
  const pool = createDatabasePool(databaseUrl);
  try {
    const result = await pool.query<{
      readonly conversation_id: string;
      readonly draft_count: string;
      readonly draft_revision: string | null;
      readonly generation_count: string;
      readonly message_count: string;
      readonly reserved_cost_usd: string;
      readonly reserved_generation_count: string;
      readonly revision: number;
      readonly selected_leaf_message_id: string | null;
    }>(
      `
        SELECT
          conversation.id::text AS conversation_id,
          conversation.revision,
          conversation.selected_leaf_message_id::text AS selected_leaf_message_id,
          (SELECT count(*)::text FROM messages
            WHERE messages.conversation_id = conversation.id) AS message_count,
          (SELECT count(*)::text FROM generations
            WHERE generations.conversation_id = conversation.id) AS generation_count,
          (SELECT count(*)::text FROM generations
            WHERE generations.conversation_id = conversation.id
              AND generations.accounting_status = 'reserved') AS reserved_generation_count,
          (SELECT coalesce(sum(generations.reserved_cost_usd), 0)::text FROM generations
            WHERE generations.conversation_id = conversation.id
              AND generations.accounting_status = 'reserved') AS reserved_cost_usd,
          (SELECT count(*)::text FROM drafts
            WHERE drafts.conversation_id = conversation.id) AS draft_count,
          (SELECT max(drafts.revision)::text FROM drafts
            WHERE drafts.conversation_id = conversation.id) AS draft_revision
        FROM conversations AS conversation
        WHERE conversation.id = ANY($1::uuid[])
        ORDER BY conversation.id
      `,
      [conversationIds],
    );
    if (result.rows.length !== conversationIds.length) {
      throw new Error("The concurrency side-effect fixture was incomplete");
    }
    return result.rows;
  } finally {
    await pool.end();
  }
}

async function databaseState(
  databaseUrl: string,
  existingPool?: ReturnType<typeof createDatabasePool>,
): Promise<DatabaseState> {
  const pool = existingPool ?? createDatabasePool(databaseUrl);
  try {
    const result = await pool.query<{
      readonly active_chat_workflows: string;
      readonly active_compactions: string;
      readonly active_titles: string;
      readonly connections: string;
      readonly finalizing_chat_parents: string;
      readonly reserved_chat_accounting: string;
      readonly reserved_compaction_accounting: string;
      readonly reserved_title_accounting: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM generations
          WHERE status IN ('preparing', 'active') AND purpose = 'chat') AS active_chat_workflows,
        (SELECT count(*)::text FROM generations
          WHERE status IN ('preparing', 'active') AND purpose = 'compaction') AS active_compactions,
        (SELECT count(*)::text FROM generations
          WHERE status IN ('preparing', 'active') AND purpose = 'title') AS active_titles,
        (SELECT count(*)::text FROM generations
          WHERE status = 'finalizing' AND purpose = 'chat') AS finalizing_chat_parents,
        (SELECT count(*)::text FROM pg_stat_activity WHERE datname = current_database()) AS connections,
        (SELECT count(*)::text FROM generations
          WHERE accounting_status = 'reserved' AND purpose = 'chat') AS reserved_chat_accounting,
        (SELECT count(*)::text FROM generations
          WHERE accounting_status = 'reserved' AND purpose = 'compaction') AS reserved_compaction_accounting,
        (SELECT count(*)::text FROM generations
          WHERE accounting_status = 'reserved' AND purpose = 'title') AS reserved_title_accounting
    `);
    return {
      activeChatWorkflows: Number(result.rows[0]?.active_chat_workflows ?? "0"),
      activeCompactions: Number(result.rows[0]?.active_compactions ?? "0"),
      activeTitles: Number(result.rows[0]?.active_titles ?? "0"),
      connections: Number(result.rows[0]?.connections ?? "0"),
      finalizingChatParents: Number(result.rows[0]?.finalizing_chat_parents ?? "0"),
      reservedChatAccounting: Number(result.rows[0]?.reserved_chat_accounting ?? "0"),
      reservedCompactionAccounting: Number(result.rows[0]?.reserved_compaction_accounting ?? "0"),
      reservedTitleAccounting: Number(result.rows[0]?.reserved_title_accounting ?? "0"),
    };
  } finally {
    if (existingPool === undefined) {
      await pool.end();
    }
  }
}

function databaseWorkState(state: DatabaseState): DatabaseWorkPeaks {
  return {
    activeChatWorkflows: state.activeChatWorkflows,
    activeCompactions: state.activeCompactions,
    activeTitles: state.activeTitles,
    finalizingChatParents: state.finalizingChatParents,
    reservedChatAccounting: state.reservedChatAccounting,
    reservedCompactionAccounting: state.reservedCompactionAccounting,
    reservedTitleAccounting: state.reservedTitleAccounting,
  };
}

function mergeDatabaseWorkPeaks(peaks: DatabaseWorkPeaks, state: DatabaseState): DatabaseWorkPeaks {
  return {
    activeChatWorkflows: Math.max(peaks.activeChatWorkflows, state.activeChatWorkflows),
    activeCompactions: Math.max(peaks.activeCompactions, state.activeCompactions),
    activeTitles: Math.max(peaks.activeTitles, state.activeTitles),
    finalizingChatParents: Math.max(peaks.finalizingChatParents, state.finalizingChatParents),
    reservedChatAccounting: Math.max(peaks.reservedChatAccounting, state.reservedChatAccounting),
    reservedCompactionAccounting: Math.max(
      peaks.reservedCompactionAccounting,
      state.reservedCompactionAccounting,
    ),
    reservedTitleAccounting: Math.max(peaks.reservedTitleAccounting, state.reservedTitleAccounting),
  };
}

async function withDatabaseWorkSampling<T>(
  databaseUrl: string,
  initialState: DatabaseState,
  work: () => Promise<T>,
): Promise<{ readonly peaks: DatabaseWorkPeaks; readonly result: T }> {
  const pool = createDatabasePool(databaseUrl);
  let peaks = databaseWorkState(initialState);
  let stopped = false;
  let samplingError: Error | undefined;
  const sampling = (async () => {
    while (!stopped) {
      peaks = mergeDatabaseWorkPeaks(peaks, await databaseState(databaseUrl, pool));
      await pause(50);
    }
  })().catch((error: unknown) => {
    samplingError =
      error instanceof Error ? error : new Error("Durable work sampling failed", { cause: error });
  });

  try {
    const result = await work();
    stopped = true;
    await sampling;
    if (samplingError !== undefined) {
      throw samplingError;
    }
    return { peaks, result };
  } finally {
    stopped = true;
    await sampling;
    await pool.end();
  }
}

async function reconcileExpiredReservations(databaseUrl: string) {
  const pool = createDatabasePool(databaseUrl);
  try {
    const budget = createBudgetService(createDatabase(pool));
    return await budget.reconcileExpiredOnce(
      new Date(Date.now() + costControlTuning.reservationExpiryMs + 1_000),
    );
  } finally {
    await pool.end();
  }
}

async function warmApplication(target: URL, employee: LoadEmployee): Promise<void> {
  const responses = await Promise.all([
    jsonRequest(target, employee, "/api/health/ready", "GET"),
    jsonRequest(target, employee, "/api/session", "GET"),
    jsonRequest(target, employee, "/api/model-tiers", "GET"),
  ]);
  if (responses.some(({ status }) => status !== 200)) {
    throw new Error("The load target did not pass its warm-up requests");
  }
}

async function main(): Promise<void> {
  const options = loadOptions();
  const databaseUrl = requiredEnvironment("CAPSTONE_LOAD_DATABASE_URL");
  const authSecret = requiredEnvironment("CAPSTONE_LOAD_AUTH_SECRET");
  if (authSecret.length < 32) {
    throw new Error("CAPSTONE_LOAD_AUTH_SECRET must contain at least 32 characters");
  }
  const diagnosticsSecret = options.managedRehearsal
    ? requiredEnvironment("CAPSTONE_LOAD_DIAGNOSTICS_SECRET")
    : authSecret;
  const diagnosticsHeaders = diagnosticsAuthorization(options, diagnosticsSecret);
  await diagnosticsRequest(options.target, "read", diagnosticsHeaders);
  const managedValidatedAt = options.managedRehearsal
    ? await assertManagedRehearsalBaseline(databaseUrl)
    : undefined;
  if (!options.managedRehearsal) {
    await assertEmptyLoadDatabase(databaseUrl);
  }
  await verifyTargetDatabase(options.target, databaseUrl, diagnosticsHeaders);
  const employees = await bootstrapEmployees(
    databaseUrl,
    authSecret,
    options.employees,
    options.managedRehearsal,
    managedValidatedAt,
  );
  const runId = randomUUID();
  const compactionEmployee = employees[3];
  const warmEmployee = employees[0];
  if (compactionEmployee === undefined || warmEmployee === undefined) {
    throw new Error("The synthetic load workforce was incomplete");
  }
  await warmApplication(options.target, warmEmployee);
  const warmupCompactionSeed = await prepareCompactionSeed(
    options.target,
    compactionEmployee,
    runId,
  );
  const measuredCompactionSeed = await prepareCompactionSeed(
    options.target,
    compactionEmployee,
    runId,
  );
  const warmupFixtures: PreparedWave[] = [];
  for (let index = 0; index < warmupWaveCount; index += 1) {
    warmupFixtures.push(
      await prepareWaveFixtures(
        options.target,
        employees,
        runId,
        0,
        index === 0 ? warmupCompactionSeed : undefined,
      ),
    );
  }
  const preparedWaves: PreparedWave[] = [];
  for (let wave = 1; wave <= options.waves; wave += 1) {
    preparedWaves.push(
      await prepareWaveFixtures(
        options.target,
        employees,
        runId,
        wave,
        wave === 1 ? measuredCompactionSeed : undefined,
      ),
    );
  }
  await warmApplication(options.target, warmEmployee);
  // The complete bounded workload warms lazy schema compilation and V8 tiering before heap/RSS
  // become leak evidence; simple health checks do not exercise those finite runtime caches.
  for (const fixture of warmupFixtures) {
    await runWave(options.target, employees, databaseUrl, runId, fixture, diagnosticsHeaders);
  }
  await pause(2_000);
  const warmedState = await databaseState(databaseUrl);
  if (
    warmedState.activeChatWorkflows !== 0 ||
    warmedState.activeCompactions !== 0 ||
    warmedState.activeTitles !== 0 ||
    warmedState.finalizingChatParents !== 0 ||
    warmedState.reservedChatAccounting !== 0 ||
    warmedState.reservedCompactionAccounting !== 0 ||
    warmedState.reservedTitleAccounting !== 0
  ) {
    throw new Error("The warmed load fixture left active work or unsettled reservations");
  }
  const warmedPostIdleDiagnostics = await diagnosticsRequest(
    options.target,
    "idle",
    diagnosticsHeaders,
  );
  if (
    warmedPostIdleDiagnostics.streams.active !== 0 ||
    warmedPostIdleDiagnostics.updates.active !== 0 ||
    warmedPostIdleDiagnostics.pool.waiting !== 0 ||
    warmedPostIdleDiagnostics.pool.idle !== warmedPostIdleDiagnostics.pool.total
  ) {
    throw new Error("The warmed load target did not reach an idle baseline");
  }
  const warmedPostIdleMemory = warmedPostIdleDiagnostics.current;
  const postIdleMemory: LoadDiagnosticsSnapshot["current"][] = [warmedPostIdleMemory];
  const waves = [];
  for (let wave = 0; wave < options.waves; wave += 1) {
    if (wave > 0) {
      await pause(1_000);
    }
    const beforeWave = await databaseState(databaseUrl);
    if (
      beforeWave.activeChatWorkflows !== 0 ||
      beforeWave.activeCompactions !== 0 ||
      beforeWave.activeTitles !== 0 ||
      beforeWave.finalizingChatParents !== 0 ||
      beforeWave.reservedChatAccounting !== 0 ||
      beforeWave.reservedCompactionAccounting !== 0 ||
      beforeWave.reservedTitleAccounting !== 0
    ) {
      throw new Error("A measured wave began with active work or unsettled reservations");
    }
    await diagnosticsRequest(options.target, "reset", diagnosticsHeaders);
    const fixture = preparedWaves[wave];
    if (fixture === undefined) {
      throw new Error("A measured wave fixture was missing");
    }
    const result = await runWave(
      options.target,
      employees,
      databaseUrl,
      runId,
      fixture,
      diagnosticsHeaders,
    );
    const activeWaveDiagnostics = await diagnosticsRequest(
      options.target,
      "read",
      diagnosticsHeaders,
    );
    if (
      result.durablePolling.length === 0 ||
      activeWaveDiagnostics.updates.peakActive === 0 ||
      activeWaveDiagnostics.updates.peakActive > result.durablePolling.length
    ) {
      throw new LoadMeasurementError(
        "Durable update request concurrency did not match the reattached streams",
        "durable-updates-request-concurrency",
        {
          activeUpdateRequests: activeWaveDiagnostics.updates.active,
          peakActiveUpdateRequests: activeWaveDiagnostics.updates.peakActive,
          reattachedStreams: result.durablePolling.length,
          wave: wave + 1,
        },
      );
    }
    await pause(2_000);
    const durableState = await databaseState(databaseUrl);
    const postIdleDiagnostics = await diagnosticsRequest(
      options.target,
      "idle",
      diagnosticsHeaders,
    );
    if (
      durableState.activeChatWorkflows !== 0 ||
      durableState.activeCompactions !== 0 ||
      durableState.activeTitles !== 0 ||
      durableState.finalizingChatParents !== 0 ||
      durableState.reservedChatAccounting !== 0 ||
      durableState.reservedCompactionAccounting !== 0 ||
      durableState.reservedTitleAccounting !== 0 ||
      activeWaveDiagnostics.streams.active !== 0 ||
      activeWaveDiagnostics.updates.active !== 0 ||
      postIdleDiagnostics.streams.active !== 0 ||
      postIdleDiagnostics.updates.active !== 0
    ) {
      throw new Error("A measured wave left active work or unsettled reservations behind");
    }
    if (
      postIdleDiagnostics.pool.waiting !== 0 ||
      postIdleDiagnostics.pool.total > 10 ||
      postIdleDiagnostics.pool.idle !== postIdleDiagnostics.pool.total
    ) {
      throw new Error("A measured wave did not release the target database pool");
    }
    if (
      postIdleDiagnostics.current.heapUsedBytes > warmedPostIdleMemory.heapUsedBytes * 1.15 ||
      postIdleDiagnostics.current.rssBytes > warmedPostIdleMemory.rssBytes * 1.15
    ) {
      throw new Error("A measured wave exceeded the warmed target memory leak bound");
    }
    postIdleMemory.push(postIdleDiagnostics.current);
    const started = result.streamResults.map(
      ({ responseStartedAt, startedAt }) => responseStartedAt - startedAt,
    );
    const firstDelta = result.streamResults.flatMap(({ firstDeltaAt, startedAt }) =>
      firstDeltaAt === null ? [] : [firstDeltaAt - startedAt],
    );
    const total = result.streamResults.map(({ startedAt, terminalAt }) => terminalAt - startedAt);
    const apiDurations = result.apiMeasurements.map(({ duration }) => duration);
    const apiP50 = percentile(apiDurations, 50);
    const apiP95 = percentile(apiDurations, 95);
    const apiP99 = percentile(apiDurations, 99);
    const apiByOperation = Object.fromEntries(
      ordinaryOperationNames.map((operation) => {
        const durations = result.apiMeasurements
          .filter((measurement) => measurement.operation === operation)
          .map(({ duration }) => duration);
        return [
          operation,
          {
            p50Milliseconds: percentile(durations, 50),
            p95Milliseconds: percentile(durations, 95),
          },
        ];
      }),
    );
    const responseStartedP50 = percentile(started, 50);
    const responseStartedP95 = percentile(started, 95);
    const cancellationP50 = percentile(result.cancellationMilliseconds, 50);
    const cancellationP95 = percentile(result.cancellationMilliseconds, 95);
    if (
      apiP95 > 300 ||
      apiP99 > 750 ||
      responseStartedP95 > options.responseStartedP95ObjectiveMilliseconds ||
      cancellationP95 > 500
    ) {
      throw new LoadMeasurementError(
        "A measured wave exceeded a locked capacity latency objective",
        "capacity-latency-objective",
        {
          apiP95Milliseconds: apiP95,
          apiP99Milliseconds: apiP99,
          cancellationP95Milliseconds: cancellationP95,
          responseStartedP50Milliseconds: responseStartedP50,
          responseStartedP95Milliseconds: responseStartedP95,
          responseStartedP95ObjectiveMilliseconds: options.responseStartedP95ObjectiveMilliseconds,
          targetCpuUtilizationPercent: activeWaveDiagnostics.cpu.utilizationPercent,
          targetEventLoopMaximumDelayMilliseconds:
            activeWaveDiagnostics.eventLoop.maximumDelayMilliseconds,
          targetEventLoopP99DelayMilliseconds: activeWaveDiagnostics.eventLoop.p99DelayMilliseconds,
          targetPeakActiveStreams: activeWaveDiagnostics.streams.peakActive,
          targetPeakActiveUpdateRequests: activeWaveDiagnostics.updates.peakActive,
          targetPeakPoolWaiting: activeWaveDiagnostics.pool.peakWaiting,
          targetPoolTotal: activeWaveDiagnostics.pool.total,
          ...Object.fromEntries(
            Object.entries(apiByOperation).map(([operation, measurement]) => [
              `${operation}P95Milliseconds`,
              measurement.p95Milliseconds,
            ]),
          ),
        },
      );
    }
    waves.push({
      api: {
        byOperation: apiByOperation,
        p50Milliseconds: apiP50,
        p95Milliseconds: apiP95,
        p99Milliseconds: apiP99,
      },
      cancellation: {
        p50Milliseconds: cancellationP50,
        p95Milliseconds: cancellationP95,
        sampleCount: result.cancellationMilliseconds.length,
      },
      database: {
        ...durableState,
        peakActiveChatWorkflows: result.peakActiveChatWorkflows,
        peakActiveCompactions: result.peakActiveCompactions,
        peakActiveTitles: result.peakActiveTitles,
        peakActiveStreams: result.peakActiveStreams,
        peakFinalizingChatParents: result.peakFinalizingChatParents,
        peakReservedChatAccounting: result.peakReservedChatAccounting,
        peakReservedCompactionAccounting: result.peakReservedCompactionAccounting,
        peakReservedTitleAccounting: result.peakReservedTitleAccounting,
        reconciliation: result.reconciliation,
      },
      firstDelta: {
        p50Milliseconds: percentile(firstDelta, 50),
        p95Milliseconds: percentile(firstDelta, 95),
      },
      loadDriverMemory: {
        heapUsedBytes: process.memoryUsage().heapUsed,
        rssBytes: process.memoryUsage().rss,
      },
      memoryLeakGate: {
        baseline: "warmed-pre-measurement",
        status: "passed",
      },
      responseStarted: {
        p50Milliseconds: responseStartedP50,
        p95Milliseconds: responseStartedP95,
      },
      stream: {
        completed: result.streamResults.filter(
          ({ terminalType }) => terminalType === "response.completed",
        ).length,
        reattached: result.streamResults.filter(({ scenario }) => scenario === "reattach").length,
        durableUpdatePolls: result.streamResults.reduce(
          (total, { updatePolls }) => total + updatePolls,
          0,
        ),
        durableUpdatePollsByStream: result.durablePolling,
        failed: result.streamResults.filter(
          ({ terminalType }) => terminalType === "response.failed",
        ).length,
        cancelled: result.streamResults.filter(
          ({ terminalType }) => terminalType === "response.cancelled",
        ).length,
        p95TotalMilliseconds: percentile(total, 95),
      },
      targetApplication: {
        activeWave: activeWaveDiagnostics,
        postIdle: postIdleDiagnostics,
      },
      wave: wave + 1,
    });
  }
  const measuredPostIdleMemory = postIdleMemory.slice(1);
  if (hasMonotonicMemoryGrowth(measuredPostIdleMemory)) {
    throw new LoadMeasurementError(
      "Measured waves showed monotonic post-idle memory growth",
      "target-memory-leak-slope",
      Object.fromEntries([
        [
          "responseStartedP95ObjectiveMilliseconds",
          options.responseStartedP95ObjectiveMilliseconds,
        ],
        ...measuredPostIdleMemory.flatMap((sample, index) => [
          [`wave${index + 1}HeapUsedBytes`, sample.heapUsedBytes],
          [`wave${index + 1}RssBytes`, sample.rssBytes],
        ]),
      ]),
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        objectives: {
          apiP95Milliseconds: 300,
          apiP99Milliseconds: 750,
          cancellationP95Milliseconds: 500,
          responseStartedP95Milliseconds: options.responseStartedP95ObjectiveMilliseconds,
        },
        runId,
        targetOrigin: options.target.origin,
        workload: { activeStreams: options.employees * 2, employees: options.employees },
        warmedBaseline: warmedPostIdleDiagnostics.current,
        waves,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const knownFailures = new Map([
    ["A concurrency rejection did not match the approved stable error", "concurrency-contract"],
    ["A concurrency rejection changed branch or budget state", "concurrency-side-effect"],
    ["The synthetic cancellation was rejected", "cancellation-request"],
    ["The cancellation stream did not terminalize as cancelled", "cancellation-terminal"],
    ["The failure stream did not terminalize as failed", "failure-terminal"],
    ["A successful synthetic stream did not complete", "completion-terminal"],
    ["The prepared long branch did not exercise hidden context compaction", "compaction"],
    ["Representative ordinary traffic returned an unexpected status", "ordinary-traffic"],
    ["Representative ordinary traffic returned an invalid payload", "ordinary-traffic"],
    ["A measured wave began with active work or unsettled reservations", "settlement"],
    ["A measured wave left active work or unsettled reservations behind", "settlement"],
    ["The warmed load fixture left active work or unsettled reservations", "settlement"],
    ["The warmed load target did not reach an idle baseline", "target-idle-baseline"],
    [
      "The measured wave did not reconcile its controlled reservation",
      "reservation-reconciliation",
    ],
    ["A measured wave did not release the target database pool", "database-pool-release"],
    ["A measured wave exceeded the warmed target memory leak bound", "target-memory-leak-bound"],
    ["Measured waves showed monotonic post-idle memory growth", "target-memory-leak-slope"],
    ["A measured wave exceeded a locked capacity latency objective", "capacity-latency-objective"],
    ["The isolated load target did not provide bounded process diagnostics", "target-diagnostics"],
    ["The load target and fixture database did not match", "target-database-mismatch"],
    ["The isolated load database must be empty before fixture setup", "fixture-database-not-empty"],
    [
      "The measured wave did not reach its declared active-stream concurrency",
      "active-stream-concurrency",
    ],
    ["Synthetic response data crossed an employee boundary", "ownership-isolation"],
  ]);
  const safeFailure =
    (error instanceof LoadMeasurementError ? error.failure : knownFailures.get(message)) ??
    (/^A synthetic response stream did not start \(\d{3} [A-Z0-9_]+\)$/u.test(message)
      ? "stream-start"
      : "unexpected");
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "UnknownError", failure: safeFailure, ...(error instanceof LoadMeasurementError ? { measurements: error.measurements } : {}), outcome: "load-harness-failed" })}\n`,
  );
  process.exitCode = 1;
});
