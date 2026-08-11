# Capstone Chat v1 PRD

Status: locked decision baseline  
Last updated: 2026-08-10

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

The production-sizing and operations decisions approved on 2026-08-10 replace the active Render
candidate with one DigitalOcean Droplet and one PlanetScale Postgres cluster. They amend only the
Phase 8 hosting, network, secret custody, deployment, backup, observability-routing, recovery, and
associated operating-cost choices. Their authorized repository implementation and remaining
external acceptance gates are recorded in
[the DigitalOcean and PlanetScale amendment](../implementation/08-digitalocean-planetscale-amendment-plan.md).
The earlier [minimal Render amendment](../implementation/08-production-baseline-amendment-plan.md)
remains historical sizing and verification evidence; it is not an active operator path.
