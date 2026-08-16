# Product Scope and Experience

Status: locked for v1

## Product definition

Capstone Chat is an internal AI chat application for employees. It provides access to a small, curated set of AI service levels through a consistent Capstone-owned experience, with centralized history, administration, and cost control.

The first release is an internal company tool. Its purpose is to deliver an excellent chat experience and establish a foundation that may later connect to other Capstone applications.

## Product principles

**Locked**

- Chat is the product in v1, not a small surface attached to a larger agent platform.
- The experience should be fast, smooth, predictable, and easy to recover when a generation is cancelled or fails.
- Employees choose an understandable service level instead of a provider or model name.
- The company controls model availability, authentication, usage, and cost.
- The codebase should remain simple and pragmatic while the backend owns all meaningful behavior.

## Product language

**Locked**

- Product navigation, onboarding, administration, errors, status messages, and other interface copy are written in Spanish.
- `Fast`, `Balanced`, and `Pro` remain stable employee-facing product names and are not translated.
- Employees may write prompts in any language.
- The assistant responds in the language of the employee's latest request unless the employee asks for another language.
- Capstone does not translate or rewrite stored employee prompts or assistant responses.
- V1 keeps interface copy in one centralized TypeScript module and does not add a localization framework.
- Non-Spanish quoted or bolded interface strings elsewhere in these PRDs are descriptive behavioral labels, not approved production copy. The centralized Spanish copy module is authoritative, except that `Fast`, `Balanced`, and `Pro` remain intentionally untranslated product names.

## Browser support

**Locked**

- V1 supports current evergreen Chrome, Edge, Firefox, and Safari on desktop.
- Mobile support covers current iOS Safari and Android Chrome.
- Legacy browsers, Internet Explorer, and embedded webviews are unsupported.
- The application may rely on modern ES modules, streaming `fetch`, and current CSS capabilities without compatibility polyfills for obsolete browsers.

## In scope

**Locked**

### Application shell

- Desktop uses a two-column shell with a collapsible left sidebar and one main content area.
- The sidebar contains **Nuevo chat**, search, recent conversation history, archived access, and the employee/account menu.
- Current-conversation identity and actions adapt to the available shell. Expanded desktop pins the selected conversation as **Actual** above **Recientes**, with its title and rename, archive or unarchive, and delete actions. Collapsed desktop uses a slim title-and-action context strip in the main column. Mobile places the title and action trigger in the compact header; the drawer may repeat the pinned title but does not duplicate the action trigger.
- The selected conversation also begins with one restrained visible semantic title inside its scrollable content. It scrolls away with the messages and is not a persistent visual header.
- The tier picker is part of the composer rather than conversation chrome. It is one low-profile disclosure: the trigger shows only the current short tier name with a chevron, and its popover pairs each of `Fast`, `Balanced`, and `Pro` with its approved purpose. Status feedback stays in a persistent line programmatically associated with the trigger.
- The main area contains only the selected conversation and composer, plus the collapsed-desktop context strip described above; that strip is not a right inspector, secondary workspace panel, or persistent content header.
- On mobile, the conversation is full-width and the sidebar opens as a modal drawer from the compact header.
- Administration uses the same branded shell at `/admin` with dedicated administrative navigation and content.
- Sidebar collapse and mobile-drawer state are local presentation preferences and are not synchronized across devices in v1.
- Compact current-conversation action targets are at least 44 by 44 CSS pixels.
- One semantic conversation heading labels the visible conversation region; adaptive shell titles are navigation and action context rather than additional headings.
- At viewport heights of 30 rem or less, routine settled status text yields visual space to the conversation while remaining available to assistive technology. Important draft, generation, cancellation, warning, conflict, and error states remain visible. At 844 by 320 CSS pixels, both expanded and collapsed desktop retain at least 7.5 rem of usable message viewport, and the complete new-chat composer is initially reachable without scrolling.

### Conversations and history

- Start a new conversation.
- Persist and display conversation history.
- Search conversation titles and message text.
- Open a search result on the exact preserved branch containing the match.
- Rename, archive, and delete conversations.
- Create the initial title deterministically from the first user message, then (Phase 10 amendment) replace it once with a bounded Fast-generated title after the first completed root answer unless the employee renamed the conversation first.
- Preserve drafts across refreshes or interrupted navigation.
- Edit an earlier user message without destroying the existing continuation.
- Try an answer again without losing the prior answer.
- Undo by moving backward through the selected conversation path.
- Switch among preserved alternatives.

A new chat opens with a restrained Capstone symbol, the heading **¿En qué puedo ayudarte?**, and the composer as its primary focus. At viewport heights of 30 rem or less, the decorative symbol may be hidden to keep the complete composer initially visible. It does not show marketing copy, news, onboarding carousels, promotional model cards, a prompt marketplace, or suggested-prompt tiles. Before the first message, the composer sits near the visual center; after sending, it moves to its persistent position at the bottom of the conversation without losing focus. The transition respects reduced-motion preferences. The new-chat draft follows the same approved server-persistence behavior as conversation drafts.

History loads incrementally. The sidebar begins with the most recently updated conversations and fetches more as the employee scrolls. Opening a conversation loads the recent portion of its selected branch; scrolling upward loads older messages without moving the current viewport. Full alternative branches load only when selected.

Conversation titles use “New chat” until the first message is persisted. The first user message is whitespace-normalized and truncated to a reasonable display length for the initial title. Under the August 15, 2026 amendment that deterministic title is a provisional fallback: the first root answer consumes the one automatic-naming opportunity on every terminal outcome, but only a nonblank successful `stop` or `length` answer starts one hidden Fast title call inside an eight-second naming phase. A successful title replaces the fallback with at most 72 code points. Cancelled, incomplete, failed, empty, refused, or content-filtered first answers, edits, retries, continuations, later turns, and every failed or timed-out naming attempt permanently retain the fallback. While naming runs the composer shows **Nombrando conversación…** and generation actions stay fenced, but Stop remains available and stops only the naming. Editing the first message later does not silently rename the conversation, and a manually renamed title is never overwritten — a rename during naming wins permanently.

Employees may edit their own messages but not assistant responses. Submitting an edit creates a preserved branch and immediately requests a new answer. Trying again preserves the prior assistant response and creates another alternative. The employee may choose a different tier before either action. Partial, cancelled, and incomplete responses remain selectable alternatives unless the complete conversation is deleted.

Drafts are persisted through the backend rather than browser storage. React keeps an immediate in-memory copy and autosaves after typing pauses. Drafts synchronize across tabs and devices. A failed autosave does not interrupt typing; the UI shows a small unsaved indicator and retries after the next edit.

If another tab or device changes the same draft, a stale tab stops autosaving and displays **Draft changed in another tab**. The employee may keep the server draft or deliberately replace it with the local draft. Other stale conversation actions preserve the local draft, reload canonical state, and ask the employee to retry rather than silently creating an unintended branch.

### Composer behavior

- The composer is a plain-text input that grows to a sensible maximum height and then scrolls internally.
- On desktop, `Enter` sends and `Shift+Enter` inserts a newline.
- On mobile, Enter inserts a newline and the visible Send button submits.
- Input method editor composition never triggers submission.
- Empty or whitespace-only messages cannot be sent.
- Pasted content remains plain text and may contain Markdown.
- Employees may type and autosave their next draft while a response streams, but cannot submit it until the active generation completes or is stopped.
- During an active generation, the primary composer action becomes **Stop**.
- After completion or cancellation, the saved draft is immediately ready to send.
- While an existing conversation's preferred-tier change is being saved, controls that would begin a new generation—Send, Edit, Try again, and Continue—are unavailable. Stop remains available, and an already-running generation retains the tier committed when it started.
- Backend validation remains authoritative.

V1 user messages contain exactly one text block. Fastify validates Unicode, normalizes line endings to `\n`, rejects null bytes and unsupported control characters, and otherwise preserves whitespace and Markdown. Empty means no non-whitespace content. Oversized or over-context messages are rejected without consuming the draft, and URLs remain ordinary text rather than fetched content.

### Conversation privacy

- Conversations are private to their owning employee.
- There is no conversation sharing in v1.
- Administrators can view usage and cost metadata, but the admin UI does not expose message content, with one narrowly consented Phase 10 exception: an employee may explicitly report one terminal answer through **Reportar**, sharing that answer and its direct prompt together with a required reason and an optional note. The employee sees the exact disclosure before confirming with **Compartir y enviar**. Administrators see only that prompt/answer pair, the reporter's name and email, the reason, the note, and the time in a read-only **Reportes** inbox; they see no conversation, message, or generation identifiers, titles, surrounding messages, model metadata, or links.
- Administrator status does not automatically grant access to another employee's conversations.

### Retention and deletion

- Conversation history is retained until its owning employee deletes it.
- Archiving is reversible and removes a conversation from the normal history list.
- Archived conversations remain searchable and are labeled **Archivada** in search results.
- Opening an archived search result does not unarchive the conversation; the employee must explicitly choose **Desarchivar** to return it to the normal history list.
- Deletion requires confirmation and immediately, irreversibly removes messages, compactions, titles, answer reports, and other conversation content from the active application. A report also disappears when its reported answer is removed.
- There is no recycle bin or administrator restore in v1.
- Deleting a conversation with an active generation cancels that generation first.
- Non-content generation metadata remains available for workspace cost accounting after content deletion.
- Retained accounting metadata does not provide a link back to accessible conversation content.
- Deleted content may remain in inaccessible encrypted database backups until their finite retention period expires; this is disclosed in the deletion notice.

### Generation experience

- Smooth incremental response streaming.
- Stop an active response.
- Retry recoverably after a failure.
- Preserve useful partial output after cancellation or a mid-stream failure.
- Present clear starting, generating, compacting, completed, cancelled, and failed states.
- Mark answers that reach their output limit and offer a **Continue** shortcut.

Continue creates an ordinary visible user message asking the model to continue from where it stopped and uses the currently selected tier. It does not secretly mutate or append to the previous assistant response.

### Streaming scroll behavior

- Sending brings the new user message into view with room below for its answer.
- The UI follows streamed content only while the employee remains near the bottom.
- Scrolling upward or selecting text disengages automatic following.
- Once disengaged, streamed tokens never force the employee back to the bottom.
- A floating **Jump to latest** control indicates new content and re-enables following when activated.
- Completion, cancellation, and failure do not force a scroll.
- Opening a conversation normally starts at its selected leaf.
- Every search result resolves to a concrete preserved branch leaf.
- Opening a search result persistently selects that branch, scrolls to the matching message, and highlights it briefly.
- If the result is already on the selected branch, opening it does not create a structural change.
- Selecting a different result branch updates the conversation revision before the composer may send from it; the employee may return to another preserved branch through the normal branch controls.
- Stream updates do not trigger repeated smooth-scroll animations.

### Connection loss

- The UI shows a global offline indicator but does not provide a full offline mode.
- V1 does not resume the interrupted byte stream itself. It reattaches to the same durable
  generation through checkpoint replacements and bounded long-polled appends.
- While the producing API process survives, browser or network loss does not cancel provider work;
  the response continues checkpointing, accounting, and terminalizing.
- If durable reattachment is unavailable, the browser reloads exact canonical conversation and
  response state, then follows an active response through the existing bounded state poll.
- A transport that cannot reattach retains its partial output as recoverably **Interrupted** with an
  explicit **Try again** action.
- Capstone does not automatically generate a replacement response.
- When connectivity returns, the current in-memory draft is autosaved again.
- An unsaved indicator remains visible while a draft cannot reach the backend.
- Reloading or closing the tab may lose a draft that has never reached the backend; persistent browser storage and an offline service worker are outside v1.

### Response presentation

- Assistant answers use a clean, full-width document layout rather than chat bubbles.
- Employee messages use restrained Paper-colored cards aligned toward the right with a sensible maximum width.
- The conversation column is centered and optimized for reading. Wide tables and code blocks scroll within the column rather than widening the page.
- Repeated avatars, provider names, and model names are omitted. Role is communicated through layout and programmatic labels.
- Answer actions such as copy, try again, and branch navigation appear below the answer and remain keyboard discoverable.
- Employee-message actions, including edit and copy, remain keyboard discoverable with their message.
- Actions may become more visually prominent on hover or focus, while generation, failure, interruption, and output-limit states remain visible without hover.
- Timestamps do not appear in the normal conversation reading flow.
- GitHub-flavored Markdown paragraphs, headings, lists, task lists, blockquotes, links, and emphasis.
- Horizontally scrollable tables on narrow screens.
- Inline code and horizontally scrollable fenced code blocks with syntax highlighting for recognized languages.
- LaTeX-style inline and block mathematics.
- Copy a complete answer as its original Markdown.
- Copy an individual code block without its fence markers.
- Responsive behavior, accessible interaction, reliable scrolling, and keyboard-friendly operation.

Raw HTML, scripts, iframes, and embedded web content are never rendered. External links accept only safe protocols and open separately. Stream deltas are accumulated and rendered in animation-frame batches rather than causing one React render per token.

### Model selection

Employees see no underlying provider or model names. The composer's tier disclosure exposes exactly three stable service tiers:

| Tier | Employee-facing purpose |
|---|---|
| Fast | Quick answers for everyday questions |
| Balanced | Better quality for most work |
| Pro | Deep analysis for difficult tasks |

Balanced is the initial workspace default. Administrators can see and configure the underlying mapping and may choose another enabled tier as the workspace default.

The disclosure trigger displays only the current short tier name. Each popover option pairs a short name with its approved purpose, and a disabled option may append **No disponible**. Loading, unavailable, and failure feedback appears in the status line under the control and as the trigger's accessible description.

Each conversation stores a preferred tier. The selector controls the next generation in that conversation and does not alter earlier answers. New conversations use local selection initialized from the current workspace default; they do not persist a conversation preference until conversation creation. At least one tier must remain enabled. If a conversation's preferred tier becomes unavailable, the employee must select an available tier; the backend never silently substitutes one.

### Authentication

- Authentication uses Better Auth.
- The initial sign-in method is email and password.
- Registration is restricted to pre-approved employee email addresses; there is no open public registration.
- Sessions are revocable and owned by the backend.

Employee onboarding follows this flow:

1. An administrator approves a normalized email address and assigns `member` or `admin`.
2. Capstone sends the approved address a link to the sign-up page.
3. The employee chooses their name and password.
4. Fastify permits registration only while a pending approval exists for that email.
5. Better Auth sends a verification email.
6. Verification activates the workspace membership.
7. The employee cannot sign in or access chat before verification.

Verification and password-reset responses do not reveal whether an account exists. Deactivating an employee blocks workspace access and revokes their sessions. The first workspace and administrator are created through an explicit idempotent bootstrap command without default credentials. Transactional email remains isolated behind an internal interface. Production sends verification, password-reset, and invitation mail through Resend's HTTPS API from Fastify; local development and automated tests retain the fake provider. V1 does not add an email queue, worker, webhook receiver, inbound-mail flow, or marketing-email system.

Authentication hardening requires 12–128 character passwords without arbitrary composition rules, mandatory email verification, and a seven-day sliding session lifetime with daily refresh. Password reset revokes every session, while password change revokes all other sessions. Sensitive administrator operations require a fresh session. MFA remains outside v1.

### Administration

The same React application contains a role-gated `/admin` area. It provides simple forms and tables for:

- Approving and deactivating employees
- Revoking an employee's sessions
- Mapping Fast, Balanced, and Pro to curated OpenRouter models
- Enabling or disabling a tier
- Configuring the maximum output allowance for each tier
- Setting the monthly workspace budget
- Viewing current monthly spend
- Viewing usage by employee and tier
- Reading employee answer reports (Phase 10): a newest-first read-only inbox with no status, filters, edits, deletion, exports, or notifications

Fastify enforces administrator authorization for every administrative operation. Hiding administrative screens in the browser is not an authorization boundary.

## Out of scope

**Locked for v1**

- Document libraries and retrieval
- Skills or custom assistants
- Agents and tool execution
- Web browsing
- Long-term personal memory
- Image generation
- Shared prompt marketplaces
- Workflow automation
- Deep integrations with other Capstone applications
- Administrative charts, exports, and advanced analytics
- Teams, custom roles, and billing workflows
- Mermaid rendering, arbitrary HTML, interactive embeds, and provider-specific renderers

The underlying message format may accommodate additional content types later, but v1 user and assistant messages contain text rendered as Markdown.

## Deferred

- Future external commercialization and its additional SaaS requirements
- Connections to other Capstone applications
- Exact authentication rate limits and fresh-session duration
