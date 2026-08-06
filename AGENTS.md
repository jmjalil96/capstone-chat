# Capstone Chat Engineering Guide

## Authority

- Read `docs/prd/README.md` and the relevant PRDs before changing behavior.
- The PRDs define what Capstone Chat does. This file defines how its code is built.
- Follow the milestone order in `docs/prd/06-development-roadmap.md`.
- Never silently change a locked product, privacy, security, data, or cost decision.
- If an ambiguity would materially affect those areas, surface it. Otherwise choose the simplest implementation consistent with existing patterns.

## Core standard

The codebase should feel as though one careful engineer wrote it from beginning to end.

- Prefer the smallest complete solution for the current milestone.
- Optimize for clarity, cohesion, and maintainability—not abstraction count.
- Use one obvious pattern per concern. Extend an existing pattern instead of introducing a parallel one.
- Do not add speculative abstractions, compatibility layers, or infrastructure for hypothetical future needs.
- Add a dependency only when it makes the whole system materially simpler.
- Keep control flow direct, names precise, and files narrowly focused.
- Comment why something is necessary; do not narrate obvious code.
- Remove dead code and temporary paths when replacing them.

## Architecture boundaries

- `apps/web` owns presentation and browser interaction only.
- `apps/api` owns business rules, authorization, persistence, model access, budgets, and policy.
- `packages/protocol` contains transport schemas and inferred public types only.
- `packages/brand` contains static identity assets, tokens, fonts, and thin CSS adapters.
- Do not import API internals into the web application.
- Do not place business rules in React components or protocol schemas.
- Keep the backend a modular monolith. Do not introduce services, queues, caches, or workers without an approved requirement.

## Consistency rules

- Use strict TypeScript and explicit types at system boundaries.
- Reuse established naming, directory, error, configuration, and testing conventions.
- Centralize configuration, Spanish interface copy, protocol schemas, and stable error codes in their approved homes.
- Prefer plain functions and small modules. Use classes only when lifecycle or persistent state clearly benefits from them.
- Prefer explicit queries and transactions over generic repositories or hidden persistence behavior.
- Never hold a database transaction or connection across a network wait.
- Do not create duplicate helpers, component systems, schema systems, or error abstractions.

## Change discipline

- Keep changes small, scoped, and independently verifiable.
- Do not perform unrelated cleanup or broad refactors inside feature work.
- Preserve existing user changes and work safely in a dirty worktree.
- Update tests and documentation when behavior or a contract changes.
- Never log prompts, responses, compaction summaries, secrets, or raw provider payloads.
- Before handing off completed work, run the relevant checks. For a full milestone, run:
  - `pnpm check`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
- If a required check cannot run, state exactly why and what remains unverified.
