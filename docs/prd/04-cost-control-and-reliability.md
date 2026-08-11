# Cost Control and Reliability

Status: locked for v1

## Generation accounting

**Locked**

Every OpenRouter request creates a generation record. Chat responses and hidden context-compaction calls are both accounted for.

The record includes:

```text
id
workspace_id
user_id
conversation_id
assistant_message_id
purpose                    chat | compaction
tier
requested_model
resolved_model
provider
openrouter_generation_id
status
prompt_tokens
completion_tokens
reasoning_tokens
cached_tokens
cost
started_at
first_token_at
completed_at
error_code
```

Rules:

- OpenRouter's reported final usage and billed cost are the accounting source of truth.
- Catalog pricing is used only for estimates and preflight checks.
- Preflight checks use last-known catalog pricing with a configurable conservative margin.
- Monetary values use PostgreSQL `numeric`, never floating-point arithmetic.
- Completed, cancelled, incomplete, and failed generations remain recorded.
- Compaction cost is visible to administrators.
- Timing fields support measurement of time to first token, generation duration, and total latency.
- Daily and monthly reporting is derived from generation records initially; no separate analytics system is introduced in v1.
- Non-content generation metadata is retained for accounting after conversation content is permanently deleted.

## Budget policy

**Locked**

- All OpenRouter costs, Capstone budgets, and employee-facing or administrative cost displays are denominated in USD. V1 does not perform currency conversion.
- A workspace budget month begins at local midnight on the first calendar day and ends at local midnight on the first day of the next month, using the workspace's stored IANA timezone.
- Budget enforcement and usage reporting use the same workspace-local monthly boundary.
- The workspace has a hard monthly spending ceiling.
- Employee budgets begin as soft warnings.
- An optional hard employee limit may be added later.
- Each tier has its own maximum output allowance.
- Balanced is the default tier, while Pro may be governed more strictly.

Before an OpenRouter call begins, Fastify atomically reserves a conservative estimated maximum cost:

```text
estimated input cost
+ permitted maximum output cost
= reservation
```

The reservation lifecycle is:

```text
reserve -> generate -> settle actual cost -> release remainder
```

The budget check and reservation occur in one PostgreSQL transaction with row locking so concurrent requests cannot independently spend the same remaining budget.

Reservations expire. A reconciliation process identifies abandoned generations after an API crash and releases their unused reservations.

Each Fastify replica runs a narrow PostgreSQL-backed reconciler. Replicas claim expired records with transactional row locking and `SKIP LOCKED`, mark abandoned generations incomplete, and settle expired reservations. If a process dies before Capstone receives OpenRouter's final usage event, the reconciler retains a conservative estimated charge marked as estimated rather than risk undercounting against the hard workspace budget.

Only one generation may be active per conversation. PostgreSQL enforces this invariant across API replicas, while a separately configurable per-employee concurrency limit controls simultaneous generations across different conversations.

## Cancellation

**Locked**

Cancellation propagates through the complete request path:

```text
employee stops response
-> browser aborts fetch
-> Fastify detects cancellation
-> Fastify aborts the OpenRouter request
-> partial content is retained
-> generation is marked cancelled
-> actual usage is recorded when available
-> unused reservation is released
```

Connection loss follows the same upstream-cancellation path. V1 does not resume an interrupted stream or automatically generate a replacement response.

Stream forwarding honors downstream backpressure and bounded buffering. Database checkpoints are coalesced, terminal writes are guarded against races, and a completion event is sent only after content and accounting have been durably committed.

While a connected downstream response is otherwise quiet, Fastify emits the approved content-free
`stream.heartbeat` every 15 seconds. The browser bounds downstream silence at 35 seconds, then
performs the same canonical incomplete-response recovery as another interrupted transport. A
heartbeat never changes content, accounting, first-token timing, checkpoints, or lifecycle state.

## Fallback and retry policy

**Locked**

- OpenRouter handles provider fallback before response content begins.
- Fallback stays within the selected Fast, Balanced, or Pro tier.
- Capstone does not blindly retry a generation.
- After any content has streamed, Capstone never automatically restarts the generation.
- A mid-stream failure preserves partial content with an incomplete status.
- The UI offers an explicit **Try again** action, which creates a new assistant sibling.
- Ambiguous network failures are not automatically retried because the original request may already have incurred cost.

## Timeouts and errors

**Locked**

Every upstream request has separately configurable limits for:

- Connection establishment
- Time to first token
- Inactivity between streamed events
- Total generation duration

Employees receive stable Capstone error codes and recoverable UI states. Raw upstream errors and correlation metadata remain available to administrators and server-side diagnostics.

Raw diagnostic data must not include employee prompts, model responses, or compaction summaries. OpenRouter routing is required to use `data_collection: "deny"` and `zdr: true` for every generation.

## Production launch operating values

**Locked**

| Control | Production launch value |
|---|---:|
| Monthly workspace budget | USD 100 |
| Fast maximum output | 4,096 tokens |
| Balanced maximum output | 8,192 tokens |
| Pro maximum output | 16,384 tokens |
| Active employee chat workflows | 2 per employee |
| Cost-estimation margin | 20% (`2,000` basis points) |
| Upstream connection/headers timeout | 10 seconds |
| Time to first visible model event | 60 seconds |
| Stream inactivity timeout | 45 seconds |
| Total generation duration | 5 minutes |
| Post-stream authoritative usage lookup timeout | 10 seconds |
| Reservation expiry | 15 minutes |
| Model-catalog refresh | Hourly |

The output values are ceilings, not response targets. The hard workspace budget remains
authoritative even when a generation, compaction, timeout, cancellation, or reconciliation path is
active. The 15-minute reservation expiry is deliberately longer than the five-minute generation
ceiling and its bounded terminal accounting work, preventing the reconciler from racing a healthy
request while still releasing crash-orphaned reservations promptly.

## Deferred

- Hard per-employee budget enforcement
- A dedicated analytics platform or materialized reporting layer
