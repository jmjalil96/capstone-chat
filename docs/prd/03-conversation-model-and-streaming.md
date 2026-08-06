# Conversation, Model, and Streaming Behavior

Status: locked for v1

## Authoritative turn creation

**Locked**

The browser submits only the new message, selected parent, and service tier. It does not submit an authoritative copy of prior history.

```json
{
  "parentMessageId": "msg_123",
  "content": [
    { "type": "text", "text": "My next question" }
  ],
  "modelTier": "balanced"
}
```

Fastify loads the selected immutable branch from PostgreSQL and constructs the model request.

## User-message validation

**Locked**

- V1 accepts exactly one text content block per user message.
- Text must be valid Unicode; line endings are normalized to `\n` while other whitespace and Markdown are preserved.
- Null bytes and unsupported control characters are rejected.
- A message is empty only when it has no non-whitespace characters.
- Fastify enforces HTTP body-size and message-size limits.
- Before persistence or budget reservation, Fastify verifies that the message can fit the selected tier after the system prompt and output reserve.
- A message that cannot fit returns `MESSAGE_TOO_LARGE` and remains in the employee's draft.
- Browser warnings are advisory; backend validation is authoritative.
- URLs remain ordinary text and are not fetched or inspected in v1.
- Exact byte and token limits remain model-policy tuning values.

## OpenRouter boundary

**Locked**

OpenRouter is the only model gateway used in v1. OpenAI, Anthropic, and other providers are not integrated directly.

OpenRouter is isolated behind a deliberately small internal interface so its types do not spread through the application:

```ts
interface ModelGateway {
  stream(
    request: GenerationRequest,
    signal: AbortSignal,
  ): AsyncIterable<GatewayEvent>;
}
```

V1 has two implementations:

- `OpenRouterGateway` for production
- `FakeModelGateway` for automated tests

This boundary preserves the option to add another gateway later without creating unused provider abstractions now.

## Curated tier catalog

**Locked**

- Employees can request only `fast`, `balanced`, or `pro`.
- Raw OpenRouter model identifiers are not accepted from the browser.
- A workspace policy maps each tier to a curated OpenRouter model.
- Administrators can change mappings without a web deployment.
- Each conversation persists its preferred tier for its next generation.
- New conversations use the workspace default, which is initially Balanced.
- Administrators may select another enabled tier as the workspace default, and at least one tier must remain enabled.
- If a preferred tier is disabled, the employee must choose an available tier; the backend does not silently substitute one.
- Historical responses retain the requested tier, resolved model, actual provider, and billed cost.
- A mapping change does not rewrite historical metadata.
- Provider or model fallback stays within the selected quality tier.

Catalog operations follow these rules:

- `model_catalog` contains only models explicitly approved by an administrator.
- Adding a model requires its exact OpenRouter identifier, which Fastify validates before saving.
- Validation imports and persists model metadata, capabilities, context limits, and pricing.
- A model without successfully validated metadata cannot be enabled.
- A best-effort periodic refresh updates approved and currently mapped models only.
- Refresh failure does not prevent Fastify from starting or serving with last-known metadata.
- Administrators can trigger a manual refresh.
- If a mapped model disappears or cannot satisfy the ZDR policy, its tier becomes temporarily unavailable rather than silently crossing tiers.
- Budget estimates use last-known pricing with a configurable conservative margin; final OpenRouter cost remains authoritative.
- Refresh frequency and estimation margin remain operational tuning values.

## System prompts

**Locked**

- All three tiers use one minimal Capstone-owned system prompt.
- It identifies the assistant as Capstone Chat and asks it to be helpful, accurate, and direct.
- It asks the model to follow the employee's requested format, use Markdown when useful, and distinguish uncertainty from known facts.
- It asks the model to respond in the language of the employee's latest request unless the employee requests another language.
- It does not claim access to company systems, documents, or current information the model has not received.
- It does not invent company knowledge or layer a large custom safety policy over provider behavior.
- Employees and administrators cannot customize the system prompt in v1.
- The prompt lives in version-controlled backend code, and every generation records its version.
- Prompt changes require a reviewed deployment.
- Context compaction uses a separate versioned prompt and records that version.
- Prompt text is not supplied by the browser or database configuration.

## Generation controls

**Locked**

- Employees select only Fast, Balanced, or Pro.
- V1 does not expose temperature, top-p, reasoning-effort, context-size, or output-length controls.
- Fastify sends only parameters supported by the resolved OpenRouter model.
- Provider defaults govern sampling and reasoning unless a model mapping requires an explicit backend override.
- Workspace tier policy controls maximum output.
- Raw chain-of-thought or hidden reasoning content is not requested, stored, or displayed.
- Reasoning-token counts and cost may be recorded when OpenRouter reports them.
- Each generation records its effective non-secret parameter configuration for diagnostics.
- Parameter configuration is controlled by administrators or deployment, not arbitrary browser input.

## Streaming protocol

**Locked**

The browser uses a streaming `POST` request with newline-delimited JSON. WebSockets are not used in v1.

```http
POST /api/conversations/:conversationId/responses
Content-Type: application/json
Accept: application/x-ndjson
Idempotency-Key: <client-generated-unique-value>
```

Representative events:

```json
{"type":"response.started","messageId":"msg_123"}
{"type":"context.compacting"}
{"type":"content.delta","text":"The answer"}
{"type":"content.delta","text":" continues..."}
{"type":"response.completed","usage":{"inputTokens":200,"outputTokens":80}}
```

The event contract is extensible, but only approved v1 content and lifecycle events are implemented.

Every known stream event is validated against its shared TypeBox schema in the browser. Unknown event types are ignored for forward compatibility, while malformed known events end the stream with a protocol error.

## Stream lifecycle

**Locked**

1. Fastify authenticates the employee.
2. It validates the workspace, parent message, tier, limits, and budget.
3. It atomically creates the user message and assistant placeholder.
4. It starts the OpenRouter request and normalizes upstream events.
5. It forwards deltas and periodically checkpoints partial output.
6. It records final content, usage, cost, and timing.
7. On browser cancellation or disconnection, it aborts upstream processing when supported and preserves the useful partial answer.

The idempotency key prevents an accidental browser retry from creating a duplicate generation.

An interrupted downstream stream is not resumed in v1. Fastify cancels the upstream request, retains checkpointed partial output as incomplete, and the browser refetches the canonical conversation state. Any replacement generation requires an explicit employee action.

## Stream persistence and backpressure

**Locked**

- Each active generation has one bounded in-memory text accumulator.
- Provider deltas are forwarded to the browser immediately.
- PostgreSQL is checkpointed after a configurable time or accumulated-byte threshold, never per token.
- Only one checkpoint write may be outstanding per generation; later deltas coalesce into the next checkpoint.
- Checkpoints update the assistant placeholder rather than creating token or chunk rows.
- Checkpoint updates are conditional on the generation remaining active, so a late write cannot overwrite a terminal state.
- Fastify honors downstream write backpressure instead of buffering an unlimited response for a slow browser.
- A stalled or disconnected browser reaches the configured timeout and cancellation path.
- Final assistant content, generation status, usage, and cost are committed transactionally.
- `response.completed` is emitted only after the final database commit succeeds.
- Final-persistence failure produces a protocol failure and causes the browser to refetch canonical state.
- Checkpoint intervals, byte thresholds, and maximum buffered bytes remain load-testing decisions.

No PostgreSQL connection is held for the lifetime of the stream. Turn creation, compaction persistence, checkpoints, completion, cancellation, and reconciliation use separate short database operations. A pre-stream provider failure transitions the already-created generation to a terminal state and settles its reservation.

## Edit and try-again behavior

**Locked**

- Employees may edit user messages but not assistant responses.
- Submitting an edit creates a new user-message sibling and immediately generates a new assistant child.
- The original branch remains unchanged and selectable.
- The employee may choose Fast, Balanced, or Pro before submitting an edit.
- Trying again creates a new assistant sibling for the same user message.
- Trying again uses the tier currently selected in the picker.
- Editing and trying again require stopping any active generation in the conversation first.
- Partial, cancelled, and incomplete assistant responses remain selectable alternatives unless the conversation is deleted.

## Terminal outcomes

**Locked**

Capstone normalizes provider terminal outcomes as `stop`, `length`, `refusal`, `content_filter`, `cancelled`, or `error`.

- `stop` represents ordinary completion.
- A `length` response is saved and billed normally, displays **Reached response limit**, and offers **Continue**.
- Continue creates an ordinary visible user message requesting continuation and uses the currently selected tier.
- Continue does not secretly mutate or append to the prior assistant message.
- Refusals and filtered responses are preserved and are not automatically routed to another model.
- Try again remains an explicit employee action.
- An empty successful response is treated as a failure.
- The normalized reason is stored with the generation; sanitized provider-specific detail remains diagnostic metadata.

## Generation concurrency

**Locked**

- Only one generation may be active in a conversation.
- The employee stops the active generation before sending another message or trying again in that conversation.
- Separate conversations may generate concurrently.
- A configurable per-employee concurrency limit protects capacity and cost.
- PostgreSQL enforces the per-conversation rule across API replicas and browser tabs.
- A conflicting request receives a stable conflict response instead of creating a duplicate branch.
- Abandoned active records are reconciled together with expired budget reservations.

## Context construction and compaction

**Locked**

The backend alone decides what context OpenRouter receives. Full original history always remains in the immutable message tree.

When a selected branch approaches its context budget, Fastify builds the prompt from:

```text
System instructions
Persisted conversation compaction
Recent original messages
Latest user message
```

Compaction behavior:

- Keep approximately the latest 6–10 turns verbatim.
- Compact only the older contiguous prefix.
- Trigger at a conservative threshold that reserves output capacity.
- Use the Fast-tier model with a strict compaction prompt.
- Preserve decisions, names, requirements, code details, and unresolved questions.
- Persist and reuse completed compactions.
- Compact incrementally as additional messages age out of the recent window.
- Record compaction model usage and cost separately.
- Never delete or rewrite the original messages.

A compaction is identified by the message through which it summarizes the branch:

```text
conversation_id
through_message_id
summary
source_token_count
summary_token_count
model_used
status
created_at
```

Because each message has one parent, `through_message_id` identifies a unique historical path. An edit before that point creates a different branch, so the old compaction is not reused for the new branch.

When compaction is necessary during a request, the UI displays “Condensing earlier context…” before ordinary generation begins. If compaction fails, the backend may fall back to removing the oldest complete turns and emits a warning instead of failing the employee’s request.

## Deferred

- Exact model mappings for Fast, Balanced, and Pro
- Exact context thresholds and recent-turn count within the approved 6–10 range
- Additional content block types beyond Markdown text
- The numeric per-employee concurrency limit
