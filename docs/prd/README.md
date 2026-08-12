# Capstone Chat v1 PRD

Status: locked decision baseline  
Last updated: 2026-08-12

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

The production-hosting decisions approved on 2026-08-11 replace the active raw-Droplet path with
one DigitalOcean App Platform dynamic service in managed region `ric`, Dedicated Egress, and the
already selected PlanetScale Postgres PS-5 Single Node cluster in AWS `us-east-1`. They amend the
Phase 8 hosting, managed edge/privacy boundary, trusted client-address source, secret delivery,
deployment, observability routing, recovery procedure, and associated operating cost while leaving
the product, workload, latency, budget, data, and backup contracts locked. The source-controlled
design and the external gates that still block acceptance are recorded in
[the App Platform and PlanetScale amendment](../implementation/08-digitalocean-app-platform-planetscale-amendment-plan.md).

The August 12, 2026 source-build decision further replaces the unlaunched private-GHCR/digest
adapter with native App Platform GitHub/Dockerfile builds. GitHub Actions remains the validation
gate, protected release-pointer branches remove the source-fetch race, runtime/provider commit
identity replaces digest identity, and rollback is a reviewed forward `git revert`. The same
amendment records the explicitly accepted loss of byte-identical artifact recovery and the retained
staged provisioning, egress, database, secret, privacy, and recovery gates.

The earlier
[DigitalOcean Droplet and PlanetScale amendment](../implementation/08-digitalocean-planetscale-amendment-plan.md),
its NYC3 disposable-rehearsal record, and the
[minimal Render amendment](../implementation/08-production-baseline-amendment-plan.md) remain
historical evidence. They are not active deployment or recovery instructions and their results are
not App Platform capacity, edge, region, egress, or recovery evidence.
