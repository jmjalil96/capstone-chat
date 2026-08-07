# Phase 2 — Identity Implementation Plan

Status: implemented and accepted; the local-delivery amendment was approved by the user on 2026-08-06

Code authorization: granted by the user on 2026-08-06

## Implementation record

- Phase 1 baseline: commit `13140c5` (`Add Phase 1 foundation`). Its `check`, `typecheck`,
  `test`, and `build` gates passed before Phase 2 changes began.
- Identity dependencies: Better Auth `1.6.26`, `@better-auth/drizzle-adapter` `1.6.26`, and
  the pinned `auth` CLI `1.6.26`. The selected release is compatible with the repository's pinned
  Node.js 24, TypeScript 7, Fastify 5, Drizzle ORM 0.45, PostgreSQL 18, React 19, and Vite 8
  toolchain.
- The reviewed Better Auth Drizzle definitions regenerate without a database connection through
  `pnpm --filter @capstone/api auth:schema:generate`. The command uses the committed CLI-only
  configuration at `apps/api/src/auth/schema-generation.ts` and never invokes an unpinned remote
  package.
- Sessions expire after seven days, update after one day, and are fresh for 15 minutes. Cookie
  session caching is disabled.
- The ordinary authentication rate limit is 100 requests per 60 seconds. Stricter limits are five
  sign-in requests per 60 seconds, ten verification requests per 60 seconds, three verification
  resend requests per 15 minutes, three password-recovery requests per 15 minutes, and five
  password-reset requests per 15 minutes. Better Auth's database retention horizon is also set to
  15 minutes while an explicit catch-all preserves the effective 60-second ordinary rule; this
  prevents its cleanup pass from prematurely deleting the longer custom counters.
- Authentication request bodies are limited to 16 KiB, and the development fake mailbox retains
  at most 100 deliveries.
- `trustProxy` is `false` in every Phase 2 environment. Better Auth receives only the client address
  derived by Fastify and placed in the server-owned internal header; browser forwarding headers
  are not trusted.
- The development Vite server binds and advertises `localhost`, matching the default
  `PUBLIC_ORIGIN`. A configuration regression test keeps that exact local origin aligned; custom
  web ports must also be reflected in `PUBLIC_ORIGIN`.
- No production transactional-email provider, deployment venue, static host, secret-manager
  integration, or edge proxy is selected. Fake delivery is refused in production;
  `EMAIL_DELIVERY=disabled` is an explicit non-launch configuration until Phase 8 supplies
  deployment wiring and a real provider.
- Approved local-delivery amendment (user approval, 2026-08-06): the required fake sender is process-local, so a
  standalone operator CLI process cannot populate the separately running API process's mailbox.
  Operator results expose only the non-secret `/sign-up` path, while the browser suite exercises
  invitation links with a fake sender shared by its in-process API harness. The approval workflow,
  verification delivery, and recovery delivery remain covered; acceptance steps 5 and 8 cannot
  literally retrieve the CLI invitation from another process without replacing the required
  in-memory transport or adding forbidden persistence or an administration endpoint.
- Final repository verification passed 142 protocol, API, PostgreSQL integration, and web unit
  tests plus formatting, strict type checking, and production builds. `pnpm test:e2e` passed all
  five Chromium tests. Pinned auth-schema regeneration was byte-identical. The production API image
  built successfully, runs as non-root `node`, and contains the compiled runtime and committed SQL
  migrations. `git diff --check` passed.

## Objective

Add the smallest complete identity boundary for Capstone Chat: approved employees can create and verify an account, sign in with email and password, hold a revocable database-backed session, and reach a workspace-scoped protected surface. Operators can bootstrap the first workspace and administrator, approve another employee, and deactivate access without default credentials or a web administration system.

Phase 2 makes authentication and authorization production-shaped, but it is not a production launch and it is not a partial implementation of conversations or the Phase 7 administration experience.

The user approved the implementation choices in this plan and granted Phase 2 code authorization.
They are the implemented Phase 2 baseline. The user approved the process-local invitation
amendment on 2026-08-06, completing Phase 2 acceptance.

## Required context

Before changing files, the implementer must read:

1. `AGENTS.md` in full.
2. `docs/prd/README.md` and its decision policy.
3. `docs/prd/02-system-architecture-and-data.md`, especially architecture, local development, configuration, API contracts, frontend state, backend ownership, public routing and sessions, browser security, database access, workspace boundaries, verification, and observability.
4. The Product language, browser support, application-shell, and conversation-privacy sections of `docs/prd/01-product-scope-and-experience.md`.
5. `docs/prd/05-brand-system.md` for identity-screen presentation, product voice, accessibility, semantic colors, typography, focus, and reduced-motion behavior.
6. `docs/prd/06-development-roadmap.md`, especially the approved Identity scope and the Phase 3–8 sequence.
7. `docs/implementation/01-foundation-plan.md` and the reviewed Phase 1 implementation.
8. The current API construction, configuration, database, migration, error, shutdown, testing, web routing, query, copy, and styling patterns.
9. Current `git status`, the Phase 1 verification result, and the exact baseline against which the Phase 2 diff will be reviewed.

At implementation time, Better Auth and its Drizzle adapter must be checked against their current official documentation for Fastify integration, schema generation, email and password authentication, email verification, password recovery, session management, database hooks, cookie behavior, trusted origins, security, and PostgreSQL-backed rate limiting. The selected stable Better Auth version and CLI version are pinned in the repository; schema generation never depends on an unpinned `latest` command in CI or deployment.

The implementer must also select and record the deferred security tuning values that Phase 2 first needs:

- the fresh-session duration used by sensitive administrative authorization;
- ordinary Better Auth rate-limit window and maximum;
- stricter sign-in, verification, verification-resend, forgot-password, and reset-password limits;
- any local fake-mailbox retention bound; and
- the precise trusted-proxy rule used in each tested environment.

These are operational security values, not new product behavior. They must be centralized, named, tested, and documented. If selecting one would materially change the locked experience or security boundary, stop for approval rather than burying the choice in code.

Phase 2 does not need the conversation tree, streaming, OpenRouter, model policy, budget, compaction, or response-rendering implementation sections. Their locked requirements remain boundaries only.

## Dependency direction

```text
apps/web ──HTTP──> apps/api ───────> PostgreSQL
   │                 │
   │                 ├─────────────> Better Auth
   │                 └─────────────> EmailSender
   │                                      │
   ├──────────────> packages/protocol     └── FakeEmailSender (development/test)
   └──────────────> packages/brand

apps/api ─────────> packages/protocol
```

- Better Auth is instantiated and owned by `apps/api`; the browser never connects directly to PostgreSQL or enforces approval or membership.
- The web application may use Better Auth's thin browser client for authentication endpoint mechanics. TanStack Query remains the owner of the canonical Capstone session and workspace view.
- `packages/protocol` contains only app-owned public transport schemas and inferred types. It does not reproduce Better Auth's internal request, response, database, or plugin types.
- `EmailSender` and all approval, membership, session, and authorization behavior remain inside `apps/api`.
- The implementation extends the Phase 1 `route -> service -> explicit queries` flow. It does not add a dependency-injection container, base repository, generic command bus, or new shared package.

## Identity lifecycle

Phase 2 implements this state transition and no alternate registration path:

```text
operator approval -> pending approval
pending approval  -> sign up -> registered, unverified Better Auth user
registered user   -> successful email verification -> active membership
pending approval  -> operator revocation -> blocked
registered user   -> operator revocation -> blocked
active membership -> operator deactivation -> blocked membership + revoked sessions
```

The approval row is the server-side allowlist. The invitation email links to the ordinary Capstone sign-up page and is not itself an authentication credential. The employee still enters the approved email, name, and password, and proves control of the address through Better Auth's verification email.

The lifecycle has the following invariants:

- No public or self-approved registration exists.
- Email normalization happens in one backend function and is used consistently by bootstrap, approval, sign-up gating, membership activation, and operator lookup.
- A Better Auth user may exist before verification, but no workspace membership is active and no protected Capstone route is authorized.
- Only a currently pending approval can become an active membership.
- Verification is the event that permits activation. Membership activation is idempotent and preserves the approved `admin` or `member` role.
- Authorization checks active membership on every protected request; a valid Better Auth session alone is insufficient.
- Deactivation blocks authorization before session cleanup is attempted. Session revocation is then run and is safe to retry, so cleanup failure never restores access.
- V1 has one operating workspace and no workspace picker. Actor resolution fails closed if identity data is absent or ambiguous instead of accepting a workspace identifier from the browser.

## Work plan

Work proceeds in this order. Each step must leave the application coherent and tested before the next begins.

### 1. Preflight and Phase 1 gate

- Confirm Phase 1 is a reviewed, reproducible baseline and identify its exact commit or reviewable diff.
- Run the Phase 1 quality gates before adding dependencies or migrations.
- Inspect current official Better Auth documentation and select a stable release compatible with the pinned Node.js, TypeScript, Fastify, Drizzle, PostgreSQL, React, and Vite versions.
- Pin Better Auth, its Drizzle adapter, browser client support, and the schema CLI used by development. Do not invoke an unpinned remote CLI from normal scripts.
- Select and document the deferred Phase 2 security tuning values listed in Required context.
- Confirm that no real email provider, hosting venue, edge proxy, or production secret manager is being selected in this phase.
- Stop for direction if Phase 1 is not reproducible or a current Better Auth requirement contradicts a locked decision.

Deliverable: a short implementation note listing the Better Auth version, relevant compatibility constraints, selected tuning values, and the Phase 1 baseline.

### 2. Auth and workspace schema

- Create one Drizzle schema entrypoint used by migrations, application queries, and the Better Auth Drizzle adapter.
- Generate Better Auth's required PostgreSQL schema using the pinned CLI, then review and commit the resulting Drizzle definitions rather than running Better Auth migrations at application startup.
- Include the Better Auth core user, account, session, and verification tables plus the PostgreSQL-backed rate-limit table required by the approved configuration.
- Use Better Auth's generated string identifiers as Better Auth identifiers. Capstone tables reference them without inventing a parallel user identifier.
- Keep Better Auth table naming and adapter mapping explicit and consistent. Do not customize core fields or enable experimental adapter features without a concrete Phase 2 need.
- Add the Capstone-owned `workspaces`, `employee_approvals`, and `workspace_memberships` tables.
- Store workspace timestamps in UTC and initialize the workspace IANA timezone to `America/Guayaquil`.
- Restrict roles to `admin` and `member` with a database constraint or enum.
- Store a dedicated normalized email on approvals and enforce one approval per normalized email and workspace.
- Let an approval record a nullable Better Auth user identifier, approved role, lifecycle status, approval timestamp, activation timestamp, revocation timestamp, and ordinary audit timestamps. Do not store a password, verification token, reset token, or raw session token in a Capstone table.
- Let a membership record the workspace, Better Auth user, approved role, `active` or `deactivated` status, activation timestamp, deactivation timestamp, and ordinary audit timestamps. Enforce one membership per user and workspace.
- Use database constraints and idempotent transactions for lifecycle invariants; do not rely on a React route or process-local lock.
- Add all Better Auth and Capstone identity schema through the repository's one committed migration history and existing explicit migration command.
- Verify clean migration, upgrade from the Phase 1 schema, and rollback assumptions required by the repository's expand/contract policy. Do not add an automatic startup migration.

The approval lifecycle uses `pending`, `activated`, and `revoked`. A pending approval with a linked user represents the registered-but-unverified state; a second public state machine is unnecessary.

Boundary: Better Auth's organization plugin is not installed or used. Workspaces, roles, approval, and membership remain Capstone-owned.

### 3. Transactional email boundary and fake local delivery

- Add one small provider-neutral `EmailSender` interface inside the API with a single explicit send operation and a discriminated email purpose.
- Implement only three Spanish, brand-appropriate identity messages: employee invitation, email verification, and password reset.
- Keep template construction separate from transport while avoiding a template framework or provider SDK.
- The employee invitation contains the configured public-origin sign-up URL. It contains no approval identifier, email address, or secret in its URL.
- Pass Better Auth verification and reset URLs through the email boundary without parsing, storing, or logging their tokens.
- Do not await external-style email delivery in a way that creates account-enumeration timing behavior in public requests. Delivery failures record metadata only and leave the operation safely repeatable.
- Implement an in-memory `FakeEmailSender` for development and tests. Bound its retained message count so repeated local use cannot grow memory without limit.
- Expose fake deliveries through one clearly marked development-only local mailbox endpoint or view. Register it only when the fake sender is active in development, send `Cache-Control: no-store`, and never include it in production route registration.
- Let automated tests inspect the fake sender directly; tests do not scrape logs for links.
- Refuse the fake sender in production mode. Phase 2 builds the production API image but does not pretend that a real transactional provider has been selected.
- Never log message bodies, email verification URLs, password-reset URLs, approval email addresses as free-form text, or authentication tokens.

Boundary: do not add a queue, worker, retry service, webhook receiver, marketing-email system, or real transactional-email provider.

### 4. Better Auth server integration

- Build one configured Better Auth instance from the frozen API configuration and the existing PostgreSQL/Drizzle connection.
- Add required production configuration for the Better Auth secret and exact public origin. Development and tests may use explicit safe local values; production has no generated or insecure fallback secret.
- Enable email-and-password authentication only.
- Configure password length to 12–128 characters with no composition rule. Preserve paste and password-manager compatibility.
- Require email verification before sign-in and disable automatic sign-in after registration.
- Configure a seven-day sliding database session lifetime with daily refresh and the selected fresh-session duration.
- Disable cookie session caching so database revocation is authoritative on the next request.
- Configure password reset to revoke all sessions and password change to revoke every other session while retaining the current one.
- Set cookie behavior explicitly: `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- Configure the exact public origin as the only trusted browser origin. Do not add wildcard credentialed CORS; same-origin production and the existing Vite `/api` proxy need no permissive CORS layer.
- Enable Better Auth rate limiting in every environment used by integration tests, persist counters in PostgreSQL, and apply the selected stricter rules to sign-in, verification, verification-resend, forgot-password, and reset-password paths.
- Derive the client address from Fastify's trusted `request.ip` behavior. When forwarding a Fetch `Request` to Better Auth, replace any client-supplied internal IP header with a server-created value and configure Better Auth to read only that value. Never trust raw `X-Forwarded-For` merely because it was sent.
- Mount Better Auth's GET and POST catch-all at `/api/auth/*` through Fastify.
- Construct forwarded authentication URLs from `config.publicOrigin` and the validated request path, not from the incoming `Host` header.
- Forward status, body, and response headers exactly, including every separate `Set-Cookie` value. Add integration tests that would catch incorrectly combined cookies.
- Keep Better Auth's own CSRF handling on its routes. Do not wrap it in Capstone's app-owned JSON mutation policy or add a second CSRF-token lifecycle.
- Prevent auth route bodies, passwords, cookies, authorization headers, and token-bearing query strings from entering Pino logs or error metadata.

Boundary: do not add OAuth, social login, magic links, passkeys, username login, SSO, MFA, anonymous sessions, stateless JWTs, Redis, custom password hashing, or custom session cookies.

### 5. Approval gate, verification activation, and operator commands

- Add one canonical email normalization function. It trims surrounding whitespace, normalizes Unicode to NFC, and lowercases the address for Capstone approval comparisons. Store and compare only the canonical value in approval queries.
- Intercept Better Auth email registration at the Fastify auth boundary before user creation. Permit it to continue only when a matching pending approval exists.
- Keep the public sign-up result generic so it does not reveal whether an address is approved, already registered, or awaiting verification. React never receives the approval row.
- Link a successfully created Better Auth user to the matching approval idempotently.
- Use Better Auth's successful email-verification lifecycle hook to activate the matching membership in one short transaction.
- Make activation idempotent: repeated callbacks never create duplicate memberships, change the approved role, or reactivate a revoked approval.
- Add a narrow repair path to the protected-session resolver: when a verified user has a valid pending approval but the verification hook did not finish, rerun the same idempotent activation transaction before deciding access. This closes the failure window without a job system or alternate authorization rule.
- Add an explicit bootstrap command that accepts the initial workspace identity, workspace display name, and administrator email; creates the workspace and pending `admin` approval transactionally; and sends the invitation only after commit.
- Make bootstrap idempotent under retries and concurrent invocation. An exact repeat succeeds without duplicate records; conflicting input for an existing workspace fails visibly.
- Add an explicit employee-approval command that accepts workspace identity, employee email, and `admin` or `member`; creates or confirms the pending approval; and sends or resends the invitation after commit.
- Add an explicit employee-deactivation command that marks the membership deactivated and approval revoked before asking Better Auth to revoke all user sessions. It is idempotent and safe to rerun if session cleanup fails.
- Keep operator command output concise and intentional. It may confirm identifiers and outcomes to the invoking operator, but it never prints passwords, session tokens, verification tokens, reset tokens, or token-bearing URLs.
- Use nonzero exit status for conflicts or incomplete cleanup. Email-send failure preserves the committed approval and clearly tells the operator that rerunning the command is safe.

Boundary: these are explicit local/deployment operator commands, not HTTP administration endpoints. Phase 2 does not implement employee lists, role-editing screens, invitation dashboards, audit dashboards, or the `/admin` application.

### 6. Session view and authorization boundary

- Add one app-owned `GET /api/session` contract to `packages/protocol` and Fastify.
- Return only the authenticated employee fields the UI needs, active workspace identity and display name, role, and session timing needed for user-facing session behavior. Do not return password data, approval state, raw session tokens, internal Better Auth account rows, or unnecessary personal information.
- Resolve the Better Auth session on the server through Better Auth's supported API using the forwarded request headers.
- Resolve active Capstone membership separately and combine both into a small immutable request actor.
- Add one member guard and one administrator guard. Neither accepts a workspace or role assertion from the browser.
- Make unauthenticated requests return the stable app error `AUTHENTICATION_REQUIRED` and authenticated identities without an active workspace membership return `WORKSPACE_ACCESS_DENIED`.
- Require the selected fresh-session threshold in the administrator guard for sensitive operations. Phase 2 tests the guard directly; it does not add a fake sensitive HTTP endpoint solely to exercise it.
- Ensure deactivated users are denied immediately even if a stale cookie reaches the server during session-revocation cleanup.
- Keep the actor and guards independent of conversations so Phase 3 can reuse them without importing identity database internals into every route.
- Use TanStack Query for the browser's `/api/session` request and invalidation after sign-in, verification, sign-out, password reset, password change, or revocation-sensitive actions.

Boundary: Phase 2 does not define conversation ownership or any authorization shortcut allowing administrators to read another employee's future content.

### 7. Web identity experience

- Replace the Phase 1 foundation page as the root product experience while preserving health/readiness behavior where it remains operationally useful.
- Add only the routes required for a complete identity flow:
  - `/sign-in`
  - `/sign-up`
  - `/verify-email`
  - `/forgot-password`
  - `/reset-password`
  - `/account/security`
  - `/` as a protected, deliberately minimal post-sign-in checkpoint
- Use React Router for navigation and route protection, TanStack Query for the canonical Capstone session view, and the thin Better Auth client for sign-in, sign-up, sign-out, verification, reset, and password-change calls.
- Keep the browser a presentation client. Approval checks, verification state, roles, workspace selection, revocation, and authorization remain backend decisions.
- Centralize every new interface string in the existing Spanish TypeScript copy module. Do not add an i18n framework.
- Give all public identity outcomes calm, non-enumerating copy. Sign-up, verification resend, and password recovery do not disclose whether an account or approval exists.
- After registration, show a verification-pending state and no protected application data.
- After successful verification, refresh the canonical session view and direct the employee through ordinary sign-in if no session exists.
- The protected root displays only enough branded content to prove the employee name, workspace, role, session persistence, and sign-out. It is not the chat shell and contains no fake conversations or disabled future controls.
- The account-security view supports password change and makes its session effect clear. Password reset remains accessible without an active session.
- Use native form semantics, visible labels, concise validation summaries, programmatic status messages, and predictable focus after errors and success.
- Use correct autocomplete values for email, name, current password, and new password. Allow password pasting and password managers; do not add composition meters or arbitrary password rules.
- Keep auth and account layouts restrained, responsive, keyboard accessible, and consistent with the vendored brand variables. Do not create a component library to build a handful of forms.
- Do not persist session data, email addresses, passwords, verification tokens, or reset tokens in `localStorage`, `sessionStorage`, IndexedDB, or a service worker.
- Remove verification and reset tokens from the visible URL as soon as the required client action safely permits it, and never include them in analytics or frontend error reports.

Boundary: do not implement the two-column conversation shell, sidebar, model picker, composer, search, recent history, archived access, chat messages, or `/admin` UI.

### 8. Browser and API security hardening

- Add an exact-Origin and JSON-content-type guard for state-changing Capstone-owned endpoints. Keep `/api/auth/*` under Better Auth's own origin and CSRF enforcement.
- Reject credentialed cross-origin behavior that does not match `config.publicOrigin`; do not enable a wildcard or reflect arbitrary origins.
- Apply strict body limits appropriate to identity forms and retain Fastify's existing global safety limit.
- Add the API response security headers that are meaningful at Fastify, including a restrictive Content Security Policy compatible with the web build, `frame-ancestors 'none'`, `object-src 'none'`, and `base-uri 'self'`.
- Document the same required header policy for the future static host and edge. HSTS remains an edge responsibility and is verified in Phase 8 rather than falsely simulated in local HTTP development.
- Send `Cache-Control: no-store` for session and token-sensitive authentication responses where Better Auth does not already provide an equal or stricter policy.
- Sanitize request logging so query values on verification and password-reset URLs never appear. Preserve route templates, status, request IDs, and safe timing metadata for diagnosis.
- Keep error logs metadata-only. Never log request bodies, passwords, cookies, raw session records, email bodies, or Better Auth raw error payloads.
- Verify that invalid production auth configuration prevents readiness or startup and that fake email can never be selected in production.
- Keep the API stateless across replicas except for PostgreSQL. The fake mailbox is explicitly development-only and is not part of the deployed architecture.

### 9. Automated verification

- Use Vitest for normalization, lifecycle, authorization, configuration, email-template, protocol, and deterministic web behavior.
- Use Fastify injection for ordinary auth-adapter, session, origin, error, header, and authorization behavior.
- Use Testcontainers PostgreSQL and real migrations for Better Auth, approval, membership, session, and rate-limit integration tests. Do not mock the database boundary.
- Use Playwright with the fake sender for complete browser identity flows. Tests retrieve delivery links from the fake mailbox or injected sender, never from logs.
- Use a real local listener where cookie handling or browser behavior cannot be represented faithfully by injection.
- Keep test identities synthetic and content-free. CI uses no real employee address, Better Auth production secret, or email-provider credential.

Required Phase 2 cases:

- Every migration applies to an empty database and upgrades a Phase 1 database.
- Email normalization is deterministic across bootstrap, approval, sign-up, verification, and deactivation.
- Bootstrap is idempotent, concurrent-safe, creates no credential, and preserves `America/Guayaquil`.
- An exact repeated approval is idempotent; a conflicting role or workspace operation fails explicitly.
- An unapproved address cannot create a user and receives no approval information.
- An approved employee can register with a 12–128 character password and cannot register outside that range.
- Password paste and password-manager-compatible fields remain usable in the browser.
- Registration creates no active membership before email verification and cannot access `/api/session` as an active member.
- Successful verification activates exactly one membership with the approved role.
- A repeated verification callback or repair attempt cannot duplicate or elevate membership.
- A revoked approval cannot activate after a delayed verification callback.
- A verified active member can sign in, reload, restart the API, and retain a valid database-backed session.
- A seven-day session refreshes on the daily schedule and cookie caching remains disabled.
- Auth cookies have the required `HttpOnly`, `SameSite=Lax`, and environment-appropriate `Secure` attributes, including correct handling of multiple `Set-Cookie` headers.
- Sign-up, sign-in, verification resend, and password-recovery UI does not reveal approval or account existence beyond the locked authentication behavior.
- Password reset revokes all existing sessions.
- Password change revokes every other session and preserves the current session.
- Employee deactivation blocks authorization immediately and removes all Better Auth sessions, including across two API instances.
- The member guard rejects no-session, unverified, no-membership, revoked, deactivated, and ambiguous-membership cases.
- The administrator guard accepts only an active administrator and rejects members, stale sessions for sensitive operations, and browser-supplied role or workspace claims.
- PostgreSQL-backed rate limits are shared by two API instances and stricter auth-route rules take precedence over the ordinary rule.
- Client-supplied forwarding headers cannot spoof the address used for rate limiting.
- Auth URL forwarding ignores a hostile `Host` header and uses the configured public origin.
- Cross-origin and invalid content-type Capstone mutations are rejected; Better Auth's own CSRF behavior remains intact.
- Token-bearing verification and reset query values, passwords, cookies, and fake email bodies do not appear in captured logs.
- Fake mailbox routes exist only in development and fake email configuration fails closed in production.
- Identity forms, error states, status messages, focus behavior, keyboard behavior, and responsive layout pass the Phase 2 accessibility checks.

### 10. CI, container, and documentation

- Extend existing root commands and GitHub Actions rather than creating a second workflow system.
- Keep format/lint, type checking, unit tests, PostgreSQL integration tests, clean migrations, production builds, the API container build, and the separate Playwright job as visible gates.
- Give CI deterministic test-only auth and fake-email configuration. Never provide a production Better Auth secret or real email credential.
- Verify the production API image still builds as a non-root image and contains the committed migrations and runtime code needed by Phase 2.
- Document all new environment variables with safe local examples and clear production requirements.
- Document explicit migration, bootstrap, employee approval, employee deactivation, local mailbox, sign-in, verification, password recovery, test, and troubleshooting procedures.
- Document that migrations and bootstrap are deployment/operator actions and never run automatically when an API replica starts.
- Document the Phase 2 production limitation honestly: a real transactional email provider and deployment wiring remain unselected, so fake delivery is not launch-capable.
- Record the selected Better Auth version and the command used to regenerate its reviewed Drizzle schema.

## Phase boundary

The following are explicitly forbidden in Phase 2, including as placeholders, disabled controls, empty tables, generic abstractions, or preinstalled dependencies unless the Identity work above itself requires them.

### Phase 1 — Foundation

- Do not replace the workspace, TypeScript, Biome, Fastify construction, database pool, migration runner, error envelope, React Router, TanStack Query, brand, testing, CI, or container patterns with parallel systems.
- Foundation refactoring is allowed only when directly required for identity and must remain small and covered by the existing Phase 1 tests.
- Do not fold migrations or bootstrap into API startup.

### Phase 3 — Conversation core

- No conversation, message, draft, branch, archive, deletion, search, cursor, revision, or idempotency tables or routes.
- No conversation ownership queries beyond preserving the rule that a future administrator will not bypass employee ownership.
- No sidebar, conversation history, composer, search, or new-chat behavior.

### Phase 4 — Streaming chat

- No NDJSON event catalog or stream parser implementation.
- No `ModelGateway`, `FakeModelGateway`, `ChatRuntime`, generation state, streaming route, cancellation, checkpoint, or recovery behavior.
- No stream registry, worker, queue, or reconciler.

### Phase 5 — Conversation controls

- No edit, try-again, undo, branch navigation, answer copying, code copying, Markdown, mathematics, syntax highlighting, scroll controller, or response-format gallery.

### Phase 6 — OpenRouter and cost control

- No OpenRouter dependency, key, catalog, provider request, ZDR validation, tier mapping, model placeholder, generation accounting, usage table, budget, reservation, settlement, cancellation accounting, or reconciliation.
- Bootstrap does not invent a model policy or budget before those milestones need them.

### Phase 7 — Compaction and administration

- No `/admin` route, employee-management HTTP API, employee list, approval form, role editor, reactivation UI, session-management dashboard, model administration, budget administration, usage table, or compaction behavior.
- Phase 2 operator commands are the only approval and deactivation surfaces. They may call narrowly scoped services that Phase 7 later reuses, but they do not create a generic administration framework.
- No administrator may read another employee's future conversation content.

### Phase 8 — Production hardening

- No real transactional-email provider, email webhooks, deployment platform, secret-manager adapter, static-host configuration, edge-proxy configuration, HSTS automation, OpenTelemetry SDK, observability vendor, load-test infrastructure, backup automation, or disaster-recovery automation.
- Phase 2 implements and tests the application-side security contract and documents the future edge requirements; it does not claim production readiness.

### Identity features outside approved v1 scope

- No public registration, self-service approval, custom password storage, OAuth, social login, magic links, passkeys, username login, SSO, MFA, organizations plugin, teams, groups, custom roles, impersonation, anonymous access, workspace switching, or persistent browser auth storage.
- No default administrator password, default employee credential, or committed real identity.
- No account sharing, conversation sharing, or administrator content access.

## Acceptance procedure

From the reviewed Phase 1 baseline with Docker available:

1. Install dependencies with the repository-pinned pnpm version.
2. Start local PostgreSQL and apply the complete migration history explicitly.
3. Run the bootstrap command twice with the same workspace and synthetic administrator email; confirm one workspace, one pending admin approval, no user credential, and two successful idempotent outcomes.
4. Start the API and web application in development with fake email enabled.
5. Open the fake local mailbox, follow the administrator invitation, register, and confirm protected access remains unavailable before verification.
6. Follow the verification delivery, sign in, and confirm the protected root shows the correct workspace and `admin` role without exposing approval or Better Auth internals.
7. Restart the API and confirm the database-backed browser session remains valid.
8. Approve a synthetic member with the operator command and complete the same invitation, registration, verification, and sign-in flow.
9. Confirm a member cannot pass administrator authorization and cannot choose a role or workspace through browser input.
10. Open two sessions for one employee, change the password in one, and confirm only the other session is revoked.
11. Open two sessions again, complete password reset, and confirm both sessions are revoked.
12. Sign in again, deactivate the employee through the operator command, and confirm protected access is denied immediately and all session rows are revoked.
13. Run the two-instance PostgreSQL rate-limit test and the trusted-client-IP spoofing test.
14. Inspect captured logs while exercising registration, verification, reset, invalid credentials, and fake mailbox access; confirm no password, cookie, token, token-bearing URL, or email body is present.
15. Verify exact-origin rejection, cookie attributes, no-store behavior, security headers, and hostile-Host handling.
16. Run `pnpm check`.
17. Run `pnpm typecheck`.
18. Run `pnpm test`.
19. Run the Playwright identity suite through the repository's separate browser command.
20. Run `pnpm build` and build the production API container.
21. Verify missing production auth configuration fails closed and fake email cannot be selected in production.
22. Audit dependencies, routes, schemas, UI, scripts, and documentation to confirm none of the forbidden Phase 3–8 concerns were introduced.

## Definition of done

Phase 2 is complete only when:

- The approved root quality gates and Phase 2 browser suite succeed.
- The committed migration history contains the reviewed Better Auth schema and only the approved Capstone workspace, approval, and membership schema.
- Bootstrap and employee approval are explicit, idempotent, documented operator actions with no default credentials.
- Only a pending approved email can register, and registration cannot grant protected access before verification.
- Successful verification creates exactly one correctly scoped membership with the approved role.
- Every protected request requires both a valid Better Auth session and an active Capstone workspace membership.
- Database-backed sessions persist across API replicas and restarts, slide for seven days with daily refresh, and revoke according to deactivation, password-reset, and password-change rules.
- PostgreSQL-backed rate limiting and the trusted client-address boundary work across replicas.
- Cookie, Origin, CSRF ownership, request-body, response-header, and production-configuration behavior matches the locked security boundary.
- Spanish identity screens complete sign-up, verification, sign-in, sign-out, forgot-password, reset-password, and password-change flows accessibly.
- Fake email makes local development and CI deterministic, is bounded and non-secret in logs, and cannot run in production.
- Documentation lets another developer reproduce every Phase 2 operator and employee flow without unstated steps.
- The production API image still builds, while the absence of a real email provider is documented honestly rather than hidden behind an insecure fallback.
- The final diff contains no Phase 3–8 schema, dependency, route, UI, background process, or placeholder architecture.
- Any failed or unavailable verification is reported explicitly rather than treated as complete.

Completion of Phase 2 authorizes no automatic work on Phase 3. Phase 3 begins only after Phase 2 is reviewed and explicitly approved.
