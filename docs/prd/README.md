# Capstone Chat v1 PRD

Status: locked decision baseline  
Last updated: 2026-08-20

This directory records only the Capstone Chat decisions explicitly approved during product discovery. It is the baseline for continued design and implementation.

## Documents

1. [Product scope and experience](./01-product-scope-and-experience.md)
2. [System architecture and data boundaries](./02-system-architecture-and-data.md)
3. [Conversation, model, and streaming behavior](./03-conversation-model-and-streaming.md)
4. [Cost control and reliability](./04-cost-control-and-reliability.md)
5. [Brand system](./05-brand-system.md)
6. [Development roadmap](./06-development-roadmap.md)

## Decision policy

- A statement marked **Locked** is an approved requirement or architecture decision.
- A statement marked **Deferred** was explicitly left for a later decision.
- Details that do not appear in these documents have not been approved by implication.
- Later decisions may amend this baseline, but should do so explicitly.

The August 14, 2026 chat-shell simplification decision amends the locked application-shell
placement without changing conversation, model-policy, persistence, privacy, security, data, or
cost contracts. The current conversation is now identified through an adaptive shell surface:
the pinned **Actual** row on expanded desktop, a slim context strip on collapsed desktop, and the
compact header on mobile. A restrained semantic title remains the first block in the scrollable
conversation and scrolls away with the messages. Conversation actions move with the adaptive shell
surface, while the tier control moves into the compact compound composer. After a native-selector
pass was implemented and rejected on review, the tier control is a low-profile disclosure whose
trigger shows the current short tier name; each popover option pairs a short name with its approved
purpose, and status feedback stays beside the control. The
otherwise conversation-and-composer-only main-area rule explicitly permits the collapsed-desktop
strip, and the centered new-chat state remains required. Compact conversation action targets are at
least 44 by 44 CSS pixels, and short-height layouts must retain usable message and composer space.
As a new Phase 9 behavior, an existing-conversation tier save temporarily fences Send, Edit, Try
again, and Continue but never Stop. The same decision adds one
explicit exception to the locked focus-indicator rule in the brand system: the programmatically
focused conversation reading region shows a restrained teal-ink leading accent on its edge and
title instead of a region-sized offset ring, which design review rejected; every operable control
keeps the standard ring. The exact amendment, implementation boundary, and verification
plan are recorded in
[the Phase 9 chat-shell simplification plan](../implementation/09-chat-shell-simplification-plan.md).
The Phase 3 and Phase 6 implementation plans remain historical records of their approved and
implemented milestones; their earlier header placement and tier-control descriptions are not
rewritten retroactively.

The August 15, 2026 resilient-responses and employee-feedback decision (Phase 10) amends four
locked contracts without changing model policy, budgets, persistence ownership, or the transport
shape of existing events. First, the deterministic first-message title becomes a provisional
fallback: a new conversation receives one bounded Fast title attempt inside an eight-second naming
phase after its first completed root answer, during which the parent chat is internally
`finalizing` (publicly still `active`) and generation actions stay fenced; manual renames always
win, and `title` becomes a third accounted purpose shown to administrators as `Título`. Second,
downstream disconnection no longer cancels generation: the browser reattaches to the same
generation through a durable, cursor-based updates endpoint while explicit Stop, logout,
deletion, deactivation, provider limits, the five-minute timeout, and shutdown still cancel work.
Third, administrators receive one narrowly consented content exception: an employee may
explicitly report one answer, sharing that answer and its direct prompt with a reason and optional
note; administrators see only that pair and reporter metadata and gain no conversation access.
Fourth, reports disappear with their source content. The exact contracts, guardrails, compatibility
rollout boundary, pre-launch no-user exception, and verification plan are recorded in
[the Phase 10 resilient responses and feedback plan](../implementation/10-resilient-responses-and-feedback-plan.md).

The August 17, 2026 workspace-behavior-controls decision (Phase 11) amends the locked prompt,
model-policy, administration, persistence, generation-snapshot, and one-time deployment contracts.
A mandatory code-owned base prompt remains locked while one normalized, immutable-revisioned
workspace layer supplies administrator-owned company context and rules. Administrators also gain
bounded per-tier temperature, reasoning-effort, and reasoning-budget settings, with complete
actor-attributed policy history and append-only revert. Active members may read the current
workspace and locked rules but cannot edit them. The total output allowance continues to include
visible output and hidden reasoning; the reasoning budget is a non-additive sub-cap. Provider
capability resolution is conservative, every reasoning request excludes traces, and raw reasoning
content remains outside persistence, logs, telemetry, reports, and the browser.

Phase 11 preserves the authoritative Phase 10 database and follows the ordinary expand/contract
deployment rule. Additive migration `0009` backfills truthful `migration` snapshots while retaining
schema-1 initialization and predecessor version-1 writes; Phase 11 application code explicitly
writes version 2. It does not quiesce the application, replace the database, expose initialization
credentials to deployment components, or add a custom workflow operation. A later `0010` contract
migration remains reserved until production acceptance. The exact product decisions, limits,
initial values, corrected release choreography, prior failed attempt, and verification gates are recorded in
[the Phase 11 workspace behavior controls plan](../implementation/11-workspace-behavior-controls-plan.md).

The production-hosting decisions approved on 2026-08-11 replace the active raw-Droplet path with
one DigitalOcean App Platform dynamic service in managed region `ric`, Dedicated Egress, and the
already selected PlanetScale Postgres PS-5 Single Node cluster in AWS `us-east-1`. They amend the
Phase 8 hosting, managed edge/privacy boundary, trusted client-address source, secret delivery,
deployment, observability routing, recovery procedure, and associated operating cost while leaving
the product, workload, latency, budget, data, and backup contracts locked. The source-controlled
design and the external gates that still block acceptance are recorded in
[the App Platform and PlanetScale amendment](../implementation/08-digitalocean-app-platform-planetscale-amendment-plan.md).

The August 12, 2026 source-build decision further replaces the published but production-unused
GHCR/digest adapter with native App Platform GitHub/Dockerfile builds. GitHub Actions remains the validation
gate, protected release-pointer branches remove the source-fetch race, runtime/provider commit
identity replaces digest identity, and rollback is a reviewed forward `git revert`. The same
amendment records the explicitly accepted loss of byte-identical artifact recovery and the retained
staged provisioning, egress, database, secret, privacy, and recovery gates.

The August 20, 2026 staging decision supersedes managed load rehearsal and routine validation on
the closed production stack. Every accepted `main` commit now advances a protected staging source
pointer without force and is built, migrated, activated, contract-validated, and readiness-checked
on a persistent staging App before it may be selected for production. Staging uses
`NODE_ENV=production`, `CAPSTONE_ENVIRONMENT=staging`, the fixed
`https://staging.chat.capstone.com.ec` origin, a dedicated low-limit OpenRouter key, a dedicated
Resend sender with an application-enforced recipient allowlist, synthetic data, a separate PS-5
database, one 512 MiB service, and one 512 MiB migration job without Dedicated Egress. Production
retains its existing origin, sizes, credentials, Dedicated Egress, edge policy, and authoritative
database. Both environments use the same Dockerfile, normal server command, migration-only
`PRE_DEPLOY` job, and focused read-only contract validator. This does not restore image/digest
publication, byte-identical rebuild claims, hosted fake-model load infrastructure, or a routine
source-preparation operation. Provider-native health bootstrap remains a first-provisioning or
controlled-recovery tool only. Isolated PITR and cold-recreation exercises remain distinct
recovery rehearsals. The implementation boundary is recorded in the
[staging and deployment simplification plan](../implementation/staging-deployment-simplification-plan.md).

The earlier
[DigitalOcean Droplet and PlanetScale amendment](../implementation/08-digitalocean-planetscale-amendment-plan.md),
its NYC3 disposable-rehearsal record, and the
[minimal Render amendment](../implementation/08-production-baseline-amendment-plan.md) remain
historical evidence. They are not active deployment or recovery instructions and their results are
not App Platform capacity, edge, region, egress, or recovery evidence.
