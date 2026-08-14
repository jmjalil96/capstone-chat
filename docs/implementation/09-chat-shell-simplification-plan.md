# Phase 9 — Chat Shell Simplification and Compact Composer Plan

Status: corrective visual pass implemented and automated verification complete on 2026-08-14;
user acceptance pending

Code authorization: granted by the user on 2026-08-14

## Planning record

- Phase 9 starts from commit `ea9c5c4` (`Fix Markdown answer spacing`). The only pre-existing
  working-tree modification at authorization is
  `docs/implementation/08-digitalocean-app-platform-planetscale-amendment-plan.md`; it belongs to
  the user, remains outside Phase 9, and must not be modified or included in Phase 9 verification
  claims.
- Read-only review covered the application shell, both simultaneously mounted responsive shell
  trees, conversation action controller and dialogs, conversation focus paths, tier preference
  hook, new-chat tier state, `DraftEditor`, relevant tests, and the locked PRDs before approval.
- The review confirmed that the earlier locked header placement in
  `docs/prd/01-product-scope-and-experience.md` must be amended explicitly. It also confirmed that
  the desktop sidebar, mobile header, and a second drawer copy of the sidebar are mounted at the
  same time and hidden responsively with CSS, so duplicating an action controller would create real
  duplicate-ID and duplicate-mutation hazards.
- The existing `ConversationActions` implementation already has narrow canonical, generic-error,
  and stale-error seams suitable for extraction. Phase 9 preserves its server-authoritative
  mutation behavior instead of introducing another state owner.
- The user approved the complete corrected plan and authorized implementation on 2026-08-14. This
  authorization covers repository code, tests, and documentation only. It does not authorize a
  commit, push, pull request, production deployment, external service mutation, or paid action.
- The first functionally complete visual pass was rejected before merge or deployment. Read-only
  review confirmed that its architecture and behavior were sound but its presentation was not:
  the pinned title lost its intended prominence through the CSS cascade, the only semantic title
  was visually hidden, route focus framed the whole pane, textarea focus was clipped, long native
  option text truncated, the disclosure was oversized, direct loads shifted shell identity, the
  filtered history could leave an orphaned heading, and short-height usability was not tested or
  implemented. The user approved a bounded corrective visual pass that retains the Phase 9 state,
  mutation, and responsive ownership model.

## Authority and amendment semantics

Read this plan with `AGENTS.md`, `docs/prd/README.md`, all six locked PRDs, and the accepted Phase 3
through Phase 8 implementation records.

Phase 9 is a post-roadmap presentation and interaction amendment. It does not reorder or reopen the
eight accepted delivery milestones. It supersedes only these active presentation requirements:

| Earlier requirement | Approved Phase 9 replacement |
|---|---|
| The conversation header contains its title, tier picker, and conversation actions. | There is no oversized or persistent visual conversation header. One restrained title begins the scrollable conversation, current-conversation identity and actions live in an adaptive shell surface, and tier selection lives in the compound composer. |
| The main area contains only the selected conversation and composer. | It still contains no inspector, secondary workspace, or unrelated panel; collapsed desktop may also contain one slim current-conversation context strip. |
| Phase 3 places rename, archive or unarchive, and delete in the conversation header. | Those remain the complete conversation-action set, but their single controller is invoked from the adaptive current-conversation surface. |
| Phase 6 renders tier selection in the existing conversation header and new-chat path. | Existing and new chats use one low-profile tier disclosure inside the composer; a first native-selector pass was implemented and rejected on design review. |

The Phase 3 and Phase 6 plans remain historically accurate implementation records and are not
rewritten. Every product, privacy, security, data, model-policy, cost, transport, API, protocol,
database, retention, and operational decision not named above remains locked.

Phase 9 adds four decisions that are changes, not preservation claims:

1. Compact current-conversation action targets are at least 44 by 44 CSS pixels.
2. While an existing conversation's tier preference is being saved, Send, Edit, Try again, and
   Continue are fenced from starting a new generation. Stop remains available. New chat has local
   tier state and therefore has no preference-save-pending state.
3. The tier disclosure exposes only `Fast`, `Balanced`, and `Pro`; a disabled popover option may
   append **No disponible**. Each popover option pairs its short name with its approved purpose,
   and status feedback is the trigger's accessible description in a persistent status line.
4. At viewport heights of 30 rem or less, routine settled status text becomes visually hidden but
   remains exposed to assistive technology, important states remain visible, and the layout must
   preserve the locked short-height message and new-chat geometry.

## Objective

Replace the oversized visual conversation header and radio-card tier presentation with a calmer,
adaptive current-conversation surface and one compact compound composer:

- expanded desktop pins the selected conversation as **Actual** above **Recientes**;
- collapsed desktop uses a slim title-and-action strip in the main column;
- mobile uses the existing compact shell header for the title and action trigger; and
- the scrollable conversation begins with a restrained title that moves away with its messages; and
- new and existing chats place a low-profile tier disclosure (current short name plus chevron)
  and Send or Stop in the composer footer, with purposes inside the popover.

The new-chat symbol, **¿En qué puedo ayudarte?** heading, primary composer focus, near-center
placement before first send, and bottom-docked transition after send remain unchanged at normal
heights. The decorative symbol may be hidden in the approved short-height mode so the complete
composer is initially usable.

## Scope boundaries

- `apps/web` owns all Phase 9 presentation and browser interaction.
- TanStack Query remains the browser owner of canonical conversation detail and preferred-tier
  server state. React context or another global store does not duplicate it.
- Fastify remains authoritative for conversation mutations, tier availability, generation
  admission, draft persistence, and every business rule.
- Phase 9 changes no API route, public schema, protocol event, migration, table, model mapping,
  model-selection rule, budget rule, privacy boundary, security rule, retention rule, or cost.
- Phase 9 adds no dependency, form framework, component system, generalized state abstraction,
  service, queue, cache, or worker.
- “All conversation actions” means rename, archive or unarchive, and delete. Message edit, copy,
  retry, branch, Undo, and Continue controls remain attached to their existing content surfaces.
- Only the selected conversation exposes the conversation-action disclosure.

## Implementation plan

### 1. Record the approved product amendment

- Amend `docs/prd/README.md` and the Application shell, Composer behavior, and Model selection
  sections of `docs/prd/01-product-scope-and-experience.md`.
- Preserve the rule that new chat is centered before the first send.
- Do not edit the Phase 3 or Phase 6 implementation records; this document explains which of their
  historical presentation choices Phase 9 replaces.
- Do not modify the pre-existing dirty Phase 8 amendment.

### 2. Extract one conversation-action controller

- Move the existing action disclosure state, rename/archive/unarchive/delete mutations, error
  recovery, and dialogs out of `conversation-page.tsx` into one focused module.
- Derive the selected conversation identifier from the route and subscribe to its existing
  conversation-detail query. Do not infer the current title from the paginated history list and do
  not copy canonical detail into shell context.
- Mount exactly one action controller and one set of dialogs even though desktop and mobile shell
  variants coexist in the DOM. Generate unique disclosure/dialog IDs and connect the currently
  visible trigger to that single controller.
- Keep the title link and overflow button as sibling controls. The overflow control's localized
  accessible name has the form `Acciones de “{title}”`.
- Use an ordinary disclosure containing buttons. It exposes `aria-expanded`, closes on Escape and
  outside interaction, restores focus to the surviving trigger, and does not use ARIA menu roles.
- Present the disclosure as a compact 12-rem action list with borderless 44-pixel rows, quiet
  hover/focus backgrounds, and one subtle separator before the red destructive action. Its normal
  three-action state stays within approximately 9.5 rem of block height.

### 3. Add the adaptive current-conversation surface

- Expanded desktop always shows the selected conversation in a pinned **Actual** section above
  **Recientes**. Exclude the same conversation identifier from every paginated recent-history
  page, including when its title is null, duplicated, long, or Unicode-normalized differently.
- The pinned surface reads canonical detail, so direct links, search-opened conversations,
  archived conversations, and conversations beyond the first history page remain representable.
- While route detail is pending, each applicable shell surface reserves the same title and
  44-pixel action slots with a static `aria-hidden` placeholder. A direct load therefore does not
  flash the mobile logo or move the Recent section when canonical detail arrives.
- Expanded desktop uses one dedicated highlighted current-conversation row rather than composing
  it from the muted history-link style. Its title has prominent typography, archive state stacks
  beneath it, and a quiet horizontal-ellipsis icon invokes the integrated action trigger.
- An archived selected conversation stays open and pinned, displays **Archivada**, and changes its
  archive action to **Desarchivar**. Archiving does not navigate away merely because the item no
  longer belongs in recent history.
- Collapsed desktop renders one slim title/action context strip in the main column. This is an
  allowed shell affordance, not a persistent content header or secondary workspace panel.
- Mobile adds the selected title and action trigger to the existing four-rem compact header. The
  drawer may repeat the pinned **Actual** title for orientation but must not render a second action
  trigger or controller.
- Responsive visibility changes leave only one operable trigger, close an inapplicable open
  disclosure, and restore focus deterministically without targeting a CSS-hidden control.
- Recent-history emptiness is evaluated after excluding the pinned conversation identifier. The
  centralized empty copy remains visible instead of leaving **Recientes** above an empty list.

### 4. Preserve mutation and focus behavior

- Rename publishes the server-returned canonical detail and invalidates history and search. It does
  not locally reconstruct the server result.
- Archive and unarchive retain the current route, publish canonical state, update the visible badge
  and action, and return focus to the current surface's surviving trigger.
- A stale action preserves the local draft, refetches canonical state, focuses an action-local
  retryable alert, and asks the employee to retry. It does not replay the mutation automatically.
- Delete keeps the existing draft flush, active-generation cancellation, deletion confirmation and
  backup-retention notice, cache/runtime cleanup, and navigation to the focused new-chat composer.
- Keep exactly one visible semantic conversation `h1` and the existing document title while
  removing the oversized visual header container. The heading is the first block in the scrollable
  conversation, labels the region, and scrolls away normally.
- Normal route arrival focuses the visible labelled conversation region unless `focusComposer`
  route state requests composer focus. Fatal detail errors continue to focus their visible error
  heading.
- Region focus has no viewport-sized outline or inset frame. The in-flow title carries a reserved,
  restrained leading accent while its article is programmatically focused.
- Branch switching and Undo focus the conversation region after canonical adoption. Structural
  failures retain their established trigger or alert destination. Rename, archive/unarchive,
  delete, disclosure dismissal, dialog cancellation, and breakpoint transitions each have an
  explicit, deterministic focus destination.

### 5. Replace tier cards with one composer tier disclosure

- The tier control is a low-profile disclosure. Its trigger shows only the current short tier name
  plus a chevron, carries **Nivel para la próxima respuesta: {name}** as its accessible name, and
  exposes `aria-expanded` plus `aria-controls`. A first native-selector presentation was
  implemented and rejected on design review because a native option list cannot pair names with
  purposes at the moment of comparison.
- The popover pairs exactly the short names `Fast`, `Balanced`, and `Pro` with their approved
  purposes as plain buttons without ARIA menu roles; a disabled option appends the centralized
  **No disponible** copy, and the selected row is marked with `aria-pressed` plus a visible check.
- The status line is retained and referenced by the trigger's `aria-describedby`. Loading,
  unavailable, load-error, and save-error feedback appears there; the standalone always-visible
  purpose hint is removed because purposes live in the popover.
- Trigger disabling is split so focus restoration works: native `disabled` covers initial loading
  and no-available-tier states, while a pending save keeps the trigger focusable with
  `aria-disabled="true"` and an activation guard.
- Placement is collision-aware: on open the control measures available space above and below the
  trigger, opens toward the larger fit, and bounds the panel block size with internal scrolling.
  CSS also bounds the panel inline size against the viewport. The trigger and every popover row
  keep an explicit 44-pixel minimum target.
- Existing conversations retain tier policy and preference ownership in the page hook. Display the
  canonical selection until a preferred-tier mutation succeeds; do not show an optimistic tier as
  committed.
- New chat retains local tier selection initialized from the workspace default. It never enters an
  existing-conversation save-pending state.
- `DraftEditor` receives a narrow rendered tier-control slot and the existing-conversation pending
  flag. It does not fetch model policy, interpret availability, or own persistence rules.
- Retain the post-creation preferred-tier query-cache seed in `DraftEditor`, where new-conversation
  creation is orchestrated. That seed initializes cache from the tier already selected for the
  successful creation request; it is not policy ownership or a second canonical server state.
- Preserve policy loading, load-retry, unavailable-option, no-available-tier, save-error, and stale
  canonical feedback.
- The disclosure stays usable during a response stream so the employee can prepare the next
  tier,
  except while its own existing-conversation save is pending. The running generation retains its
  committed tier.
- During that save, fence Send, Edit, Try again, and Continue. Do not disable Stop because of tier
  persistence, and do not interrupt or retier an active generation.

### 6. Build one compact compound composer

- Reuse the existing `DraftEditor`; do not create a parallel new-chat or existing-chat composer.
- Use one bordered surface containing a plain textarea and a footer. Remove the textarea's reserved
  action padding and use normal `space-3`/`space-4` padding.
- Suppress the textarea's clipped internal outline and put the complete visible keyboard-focus ring
  on the compound composer with `:focus-within` and `:has(textarea:focus-visible)`.
- Give the textarea an approximately 3.5-rem default minimum height while preserving the existing
  10-rem docked and 16-rem new-chat maximum heights, autogrowth, and internal scrolling.
- Place the tier disclosure on the footer's left and Send or Stop on its right. Footer controls
  are at least 44 CSS pixels high and neither overlap nor overflow at 320 CSS pixels.
- Preserve the 48-rem content width, autosave and status rows, draft-conflict behavior, desktop and
  mobile Enter behavior, IME guard, reduced motion, Send-to-Stop replacement, and focus retention.

### 7. Correct short-height presentation

- At `max-height: 30rem`, reduce the collapsed context strip to the 44-pixel target floor, reduce
  the docked textarea to a 44-pixel minimum, and tighten dock and footer padding.
- Mark only saved-draft and completed-generation messages as routine settled statuses. Visually
  collapse those routine messages in short-height mode while preserving their live-region text for
  assistive technology. Unsaved, loading, validation, conflict, generation, cancellation, warning,
  retry, and failure states remain visible.
- The routine **service available** indicator is also visually collapsed at short height while its
  status remains programmatically available; a degraded or unavailable service state remains
  visible. The navigation row becomes its own vertical scroll boundary so it cannot collide with
  the account footer.
- At 844 by 320 CSS pixels, preserve at least 7.5 rem of message-scroller height in both expanded
  and collapsed desktop states.
- In short-height new chat, hide the decorative symbol and tighten vertical rhythm so the
  textarea, tier trigger, and Send control are visible without initial page scrolling.

## Verification plan

### Unit and integration coverage

- Dedicated pinned-current rendering, loading placeholders, post-exclusion empty history, and
  duplicate exclusion across active and archived state, null and duplicate titles, long titles,
  Unicode titles, direct detail data, and paginated history.
- Rename, archive, unarchive, and delete success; pending; generic failure; stale revision;
  canonical adoption; draft preservation; and draft flush before delete.
- One controller/dialog set, unique IDs, visible-trigger selection, disclosure Escape/outside
  dismissal, and breakpoint cleanup across simultaneously mounted shell variants.
- Focus after ordinary arrival, `focusComposer` arrival, fatal detail error, branch switch, Undo,
  stale alert, rename, archive/unarchive, dialog cancellation, disclosure dismissal, delete, and
  responsive breakpoint changes.
- New-chat local tier selection versus existing-conversation persisted selection; short option
  labels; visible selected-purpose help; loading; no available tiers; unavailable preference;
  retry; save failure; save pending; and changing the next tier while streaming.
- Send, Edit, Try again, and Continue are fenced during tier persistence while Stop remains
  operable.
- Composer default height, autogrowth, internal-scroll ceiling, compact footer, status importance,
  outer focus treatment, and Send/Stop replacement.

### Browser coverage

- Rewrite `conversation-flow.spec.ts` tier lifecycle assertions to drive the tier disclosure
  (trigger plus popover rows) while keeping that shared-database lifecycle Chromium-only and
  non-concurrent across browser projects.
- Add `@critical-chat` to the configured critical-project selection and provide a deterministic,
  fixture-backed critical flow for adaptive shell placement, action disclosure, tier disclosure,
  focus, and responsive behavior.
- Exercise expanded and collapsed desktop, mobile header and drawer, direct links, search-opened
  conversations, archived conversations, and a selected conversation outside the first history
  page.
- Verify delayed-detail placeholder stability, absence of a full-pane focus frame, one complete
  composer focus ring, compact disclosure geometry, short tier names with purposes visible inside
  the open popover, and geometry and containment at 1280 by 720, the 769/768-pixel breakpoint,
  390 by 844, 320 by 844, 844 by 320, and 200 percent text sizing. Assert the open tier popover is
  fully contained in the viewport on both the new-chat and conversation routes at 844 by 320 and
  at 200 percent text sizing.
- At 844 by 320, assert at least 7.5 rem of message-scroller height in expanded and collapsed
  desktop and a complete initially visible new-chat composer without page scrolling.
- Run automated accessibility checks with the action disclosure, the open tier popover (desktop
  and the mandatory mobile new-chat state), and each dialog open. Complete manual keyboard and
  VoiceOver checks for the critical chat path.
- Run the deterministic critical flow through the configured Firefox, WebKit, Chrome, Edge, iPhone
  WebKit, and Android Chrome projects. Broader lifecycle coverage may remain Chromium-only under
  the established practical browser-test boundary.

### Final gates

Run from the repository root:

```text
pnpm run ci
pnpm test:e2e
git diff --check
```

Also confirm that the pre-existing Phase 8 documentation modification remains untouched and is not
attributed to Phase 9. Any unavailable browser, VoiceOver, or external environment must be reported
as unverified rather than silently omitted.

## Acceptance criteria

- No oversized visual conversation header remains, and exactly one restrained visible semantic
  conversation heading begins the scrolling content and labels the conversation region.
- The selected conversation is always identifiable from canonical detail in the approved adaptive
  surface, including when archived or absent from the first history page.
- Only one action disclosure/controller/dialog set exists, and rename, archive/unarchive, delete,
  stale recovery, cancellation, and focus behavior remain server-authoritative and accessible.
- New and existing chats use one low-profile, collision-aware tier disclosure inside the compound
  composer, with short tier names on the trigger and purposes paired inside the popover.
- Existing-conversation tier persistence fences all new-generation initiators but never Stop; new
  chat has no false save-pending state.
- The compact composer preserves draft, stream, keyboard, IME, focus, autosave, conflict, sizing,
  and reduced-motion behavior without horizontal overflow at the approved narrow viewports.
- Direct loads reserve adaptive title/action geometry, conversation focus never frames the full
  pane, and short-height layouts preserve the approved message and new-chat space.
- Tests and final gates pass, or every remaining failure and unverified manual check is documented
  precisely before acceptance is requested.

## Explicit exclusions

Phase 9 does not add or change backend behavior, protocol contracts, persistence, provider/model
selection, tier availability policy, budgets, accounting, compaction, administration, privacy,
security, deployment, telemetry, production infrastructure, or operational acceptance. It does not
authorize commit, push, pull-request creation, release, or deployment.

## Implementation record

### Delivered boundary

- The locked product baseline now records the approved adaptive shell, composer-owned tier
  selector, 44-by-44-pixel compact action target, collapsed-desktop strip exception, and
  existing-conversation tier-save fence. The Phase 3 and Phase 6 records remain unchanged.
- The shell reads the selected route's existing TanStack Query detail state and renders one current
  conversation surface at a time: pinned **Actual** on expanded desktop, a slim context strip on
  collapsed desktop, and the existing compact header on mobile. The drawer repeats orientation but
  never mounts another action trigger. Static placeholders reserve title and action geometry while
  canonical detail loads.
- Current-conversation history exclusion is identifier-based across every loaded page. Null,
  duplicate, long, Unicode, archived, direct-linked, search-opened, and later-page titles retain
  their canonical representation, and an empty result after exclusion renders the centralized
  empty state.
- Conversation action lifecycle and presentation were extracted from the conversation page into a
  focused controller and a separate disclosure/dialog view. One controller and one dialog set own
  generated IDs, server-authoritative rename/archive/unarchive/delete behavior, stale recovery,
  request lifetimes, and responsive focus handoff. The corrected disclosure uses a horizontal SVG
  ellipsis and a compact borderless action list with a separated destructive row.
- Successful rename and archive publication is synchronous with the canonical mutation response;
  history, search, and response-state invalidations continue in the background and cannot leave a
  committed action visibly pending behind an unrelated refetch.
- The conversation page renders one restrained visible semantic `h1` as the first scrolling block
  and uses it for the article's restrained focus accent. The article itself has no viewport-sized
  focus frame. Ordinary arrival, explicit composer arrival, fatal detail failure, branch selection,
  Undo, structural failure, action recovery, dialogs, deletion, and responsive transitions use the
  approved focus destinations.
- New and existing chats share one compound composer. Its tier disclosure exposes exactly the
  short names Fast, Balanced, and Pro on trigger and popover rows, pairs each popover option with
  its approved purpose, remains viewport-bounded with internal scrolling when space is short, and
  keeps explicit 44-pixel targets on the trigger and rows. The outer composer owns the unclipped
  focus ring. New-chat selection remains local until conversation
  creation; existing-conversation persistence remains non-optimistic.
- Existing-conversation tier persistence fences Send, Edit, Try again, and Continue. Stop remains
  operable, and a running generation keeps its already committed tier. Draft persistence,
  streaming, keyboard/IME behavior, autosizing, conflict handling, and new-chat cache
  initialization remain in their established owners.
- A 30-rem short-height mode tightens shell and composer rhythm, visually collapses routine
  saved/completed and service-ready statuses while retaining them for assistive technology,
  preserves important states, keeps sidebar navigation separate from the account footer, and hides
  only the decorative new-chat symbol. Container-sized fallbacks also preserve the sidebar action
  list and tier-purpose help when employee text sizing makes those surfaces effectively short or
  narrow even though the physical viewport is larger.
- No API, protocol, database, provider, policy, privacy, security, cost, dependency, deployment, or
  production behavior changed.

### Verification evidence

- `pnpm run ci` passed: repository Biome checked 348 files; repository boundary and credential
  scanning checked 459 files; the operations audit and all TypeScript checks passed; 1,047 tests
  passed (204 protocol, 585 API/PostgreSQL, and 258 web); all production builds and the bundle
  report completed. The existing deferred Markdown chunk advisory remains informational.
- `pnpm test:e2e` passed 45/45 with the full Chromium suite and the configured critical Firefox
  and WebKit flows. The corrective `@critical-chat` scenario covers delayed-detail stability,
  scrolling-title focus presentation after direct and pointer navigation, one compound-composer
  focus ring, compact disclosure geometry, narrow and 200-percent tier help, expanded/collapsed
  short-height message space, constrained-navigation action visibility, and short-height new chat.
- Additional installed-channel runs passed 3/3 for Google Chrome, iPhone WebKit, and Android
  Chrome. A focused Chromium run was rebuilt from the current source before execution and passed
  1/1.
- Final `git diff --check` passed. An independent corrective review rechecked the live final tree,
  confirmed the short-height action clipping and loading-skeleton findings were closed, and found
  no remaining P1 or P2 issue. These results come from the corrective pass and do not reuse the
  rejected first pass's gate evidence.

### Explicitly unverified locally

- The Microsoft Edge channel is not installed on this Mac, so the Edge critical project could not
  run locally. The same `@critical-chat` tag is selected by its configured project for CI or an
  equipped workstation.
- Manual keyboard and VoiceOver walkthroughs were not performed in this implementation run.
  Automated keyboard/focus coverage and axe checks passed, but they are not represented as manual
  assistive-technology evidence.

The pre-existing 100-line modification in
`docs/implementation/08-digitalocean-app-platform-planetscale-amendment-plan.md` remains separate
user work and was not edited or attributed to Phase 9. No commit, push, pull request, external
service mutation, paid action, or production deployment was performed.

## Post-review corrective amendment (2026-08-14)

An extra-high-effort multi-angle code review of the uncommitted Phase 9 tree surfaced fifteen
verified findings (ten confirmed, five plausible). All fifteen were corrected in a bounded
post-review pass that preserves the Phase 9 ownership model. The user authorized the fixes.

### Findings and corrections

- **Archive retry reversal (confirmed).** After a stale archive adopted a canonical revision that
  another session had already archived, Retry replayed the toggle and silently unarchived. The
  archive mutation now takes an explicit direction captured at click time; a stale archive stores
  that direction, and a retry whose intent the canonical state already satisfies closes the
  disclosure and restores trigger focus instead of mutating.
- **Missing in-viewport focus cue (confirmed).** Canonical adoption pins the scroll to the latest
  message while focusing the region, leaving the title's leading accent off-screen. The region now
  carries its own restrained single-edge inline-start accent under `:focus-visible` — still no
  viewport-sized outline or inset frame; this refines, not reverses, the earlier presentation
  decision. Because the locked brand system requires focus indicators to be an offset ring, this
  accent is recorded as an explicit amendment in `docs/prd/05-brand-system.md` (and the PRD
  README): the non-interactive reading region is the one exception, and every operable control
  keeps the standard ring. Browser coverage asserts the cue with the title genuinely scrolled out
  of view.
- **Un-anchored shell recovery (confirmed).** The extracted action recovery collapsed the detail
  cache to one page without the canonical reposition the in-page recovery performs. A minimal
  canonical-adoption notification channel (`canonical-adoption.ts`) now lets the page clear its
  stale alerts and re-anchor on shell-driven recovery. Shell and page recoveries can overlap; a
  regression test pins the coherent combined outcome.
- **Escape and focus-out ownership (confirmed).** Both disclosures owned document-level Escape
  handlers that swallowed the key globally and never dismissed on focus-out, and their duplicated
  outside-pointer heuristic predicted browser focus incorrectly on WebKit. One shared
  `use-disclosure-dismissal.ts` hook now establishes focus ownership at open, handles Escape only
  for events originating inside the disclosure, closes on focus-out (which also makes stacked
  disclosures mutually exclusive), and restores trigger focus after an outside pointer dismissal
  only when focus verifiably settled on body or a `tabindex="-1"` surface.
- **Delayed-detail history duplication (confirmed).** Recientes excluded the detail-derived
  identifier, so a direct load briefly showed the routed conversation both pinned and in the list.
  Exclusion now uses the route-derived identifier available immediately.
- **Popover clip-root and stale geometry (confirmed, two findings).** The tier popover measured
  against the layout viewport only, ignoring the shell's `overflow: hidden` clip roots and never
  re-measuring while open. Measurement now intersects the visual viewport with every clipping
  ancestor and re-measures on window resize, visual-viewport resize and scroll, and clipping
  ancestor scroll. Browser coverage compares the panel and its first option against
  `.conversation-route`, including while resizing with the popover open.
- **Collapse focus steal (confirmed).** Collapsing the sidebar with the action panel open handed
  focus to the newly mounted context-strip trigger despite an explicit no-restore close, because
  the unmount cleanup read a render-mirrored open flag. The controller now maintains the open
  state in a synchronously updated ref, and focus-out dismissal defuses the scenario earlier.
- **Retryable error lost on reopen (confirmed).** Toggling the disclosure cleared its action
  error, discarding the only retry affordance after a failed recovery. Errors now persist across
  close and reopen until resolved.
- **Stale page banner (confirmed).** A failed page mutation's banner survived a later successful
  shell action that the pre-refactor shared state would have cleared; the canonical-adoption
  notification restores that clearing.
- **Recovery fencing gap (plausible).** Rename and delete rows ignored a pending canonical
  recovery; `canonicalRecoveryPending` is now folded into the controller's pending state, fencing
  every action row.
- **Loading tier mislabel (plausible).** The disabled tier trigger announced the workspace default
  as if selected while the persisted preference loaded. It now announces a pending placeholder
  only while genuinely loading and a neutral unknown label for unready non-loading states.
- **Rename concurrency (plausible, pre-existing).** A background refetch could clobber the open
  rename input, and preserving the input naively would have silently overwritten remote renames.
  The dialog now captures the observed revision at open, keeps the local text across remote
  updates, negotiates with the captured baseline (so a remote change deterministically 409s), and
  updates the baseline to the recovered revision on stale recovery.
- **Deleted default-tier assertion (plausible).** The rewritten integration test always switched
  tiers before sending; a restored test sends untouched and asserts the request body carries the
  workspace default with no preference write.
- **WebKit outside-click focus (plausible).** Covered by the shared hook's settled-focus check and
  exercised by the extended-browser run.

### Second corrective review (one P1, three P2)

A follow-up review of the amendment surfaced four issues, all corrected:

- **Popover resize flake (P1).** A 5× stress run showed the tier popover could remain clipped
  above the conversation route after shrinking 844×320 to 844×260: resize events can fire before
  the shell's `svh` and container-query layout settles, so the synchronous re-measure read
  mid-layout geometry. Measurement is now scheduled on the next animation frame, and a
  `ResizeObserver` on the clip roots, trigger, and panel re-measures whenever their boxes settle
  late. The browser clip-root assertion polls until settled, and a 5× stress run per engine
  passes.
- **Concurrent recovery cache regression (P2).** The page and the shell replace conversation
  detail independently, so an older canonical response arriving last could overwrite revision
  N+1 with N. All canonical adoption now flows through one revision-guarded helper that rejects
  lower revisions; losers of the race skip their re-anchor and notification side effects. Both
  completion orders are unit-tested.
- **Focus styling versus the locked brand PRD (P2).** The single-edge accent conflicted with the
  locked "2–3 px ring with a readable offset" rule. The exception is now explicit in the locked
  PRD itself (see above) rather than implied.
- **Over-broad dismissal focus fallback (P2).** The outside-press focus restoration treated every
  `tabindex="-1"` focus target as surrendered focus, which could steal focus a dismissing click
  had intentionally moved (for example to an alert). It now restores only when focus fell to body
  or to a `tabindex="-1"` ancestor that absorbed that same press as the browser's default
  fallback; intentional programmatic focus is respected, with a unit test pinning the behavior.

### Amendment verification evidence

- The extended WebKit run caught one additional defect in the first version of this amendment
  itself: WebKit moves focus to the nearest mouse-focusable ancestor (the `tabindex="-1"`
  conversation region) when a press lands on a popover row, so the new focus-out dismissal closed
  the popover before the row's click could select a tier. The hook now holds focus-out dismissal
  while a pointer press that began inside the disclosure is settling. This is exactly the defect
  class the review required extended-browser evidence for; a Chromium-only run had passed.
- `pnpm run ci` passed end to end after all corrections: Biome check, repository boundary and
  credential scanning, the operations audit, all TypeScript checks, 1,067 tests (204 protocol,
  585 API/PostgreSQL, 278 web — fifteen new web tests cover the corrected behaviors, including the
  archive-direction retry, the rename revision baseline, error persistence across disclosure
  reopen, recovery fencing, canonical re-anchoring, the recovery-overlap outcome, both
  completion orders of the concurrent-recovery revision guard, respected intentional focus after
  a dismissing click, focus-out dismissal, the neutral tier labels, and the untouched-default
  request body), all production builds, and the bundle report.
- `CAPSTONE_EXTENDED_BROWSERS=1 pnpm test:e2e` finished with 75 passed and 4 skipped. The four
  skips are the pre-configured real-identity lifecycle test on installed-channel projects. The
  only failures were the ten `edge-critical` launches, each failing with "Chromium distribution
  'msedge' is not found" — the already-recorded local limitation, unchanged by this amendment. The
  passing matrix includes both WebKit projects, which exercise the outside-click focus restoration
  and the press-focus dismissal hold. The `@critical-chat` scenario now additionally covers the
  offscreen-title focus cue, popover containment against the `.conversation-route` clip root,
  re-measurement while resizing with the popover open, mutual disclosure exclusion, and keyboard
  collapse focus retention. A dedicated 5× stress run of the `@critical-chat` scenario per engine
  (Chromium and WebKit) passed 10/10 after the re-measure scheduling fix. One earlier full-matrix
  run showed a single unrelated Chromium streaming-test timeout under full parallel load; a
  focused 3× repeat of the whole streaming spec and the final full matrix both passed it.
- Final `git diff --check` passed. Microsoft Edge remains uninstalled locally and manual keyboard
  and VoiceOver walkthroughs were again not performed; automated keyboard, focus, and axe coverage
  is not represented as manual assistive-technology evidence.
