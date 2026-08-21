# Phase 12A — Better output handoff

Status: implemented and locally verified on 2026-08-21; staging acceptance remains pending

## Product boundary

Phase 12A improves how a non-coding employee moves one stable assistant answer into Word,
Outlook, Excel, a local text file, or the operating system's print/PDF flow. It does not add
document input, conversation export, sharing, server-side conversion, storage, or integrations.

The slice is browser-only:

- **Copiar respuesta** writes allowlisted semantic HTML plus deterministic readable text.
- **Copiar Markdown** preserves the exact canonical source.
- **Copiar tabla** writes one table as formula-safe TSV.
- Markdown and readable text download from in-memory Blobs with fixed content-free filenames.
- The native print dialog receives one ephemeral sheet labeled only **Capstone Chat** and
  **Respuesta**.

Actions apply only to stable nonblank assistant content. Completed, archived, cancelled,
interrupted, failed-with-partial-output, and output-limited answers remain eligible; active streams
do not. User-message and fenced-code copy keep their existing text-only contracts.

## Serialization and privacy

Rich output is derived from a clone of the established safe rendered answer, never raw model HTML.
The serializer keeps semantic text, authored heading levels, lists, tasks, blockquotes, safe links,
footnotes, tables, code, and line endings. It represents mathematics once as authored TeX and
removes renderer controls, hidden annotations, classes, styles, IDs, data, event attributes,
forms, media, SVG, and active elements. Links are revalidated against `http`, `https`, and
`mailto`.

Readable text preserves list and task structure, safe link destinations, code whitespace, table
rows, and formula text with LF line endings. Table TSV normalizes cell whitespace and prefixes a
cell beginning with `=`, `+`, `-`, or `@` with an apostrophe. Markdown downloads are exact UTF-8
canonical source; text downloads are the deterministic readable projection. Neither uses a BOM.

If rich clipboard capability is absent before an attempt, the primary action copies readable text
and reports **Copiado sin formato**. A rejected rich attempt does not trigger a second write. A
renderer failure retains exact Markdown copy and download; text, rich, and print output never use
an unreviewed alternate renderer.

Every handoff is an explicit disclosure to the operating system or destination application. It
issues no API/provider request, browser-storage write, analytics event, or content-bearing log.
Conversation deletion cannot recall an already copied, downloaded, printed, or saved local copy.

## Interaction and print contract

The answer action row keeps **Copiar respuesta** visible and adds one ordinary **Exportar**
disclosure with Markdown copy, both downloads, and **Imprimir o guardar como PDF**. The disclosure
uses existing dismissal, focus-restoration, and 44-pixel target conventions. Each table owns an
independent **Copiar tabla** control. Success is announced through an answer-local status; failures
are content-free alerts and preserve retry focus.

Print output excludes the prompt, conversation title, surrounding messages, navigation, composer,
account data, message/report identifiers, model details, and cost. It includes the current terminal
warning when the answer is partial. A temporary print node is removed after printing, media exit,
route change, or unmount. The application does not claim that the employee saved a PDF.

## Verification and release

Unit coverage owns semantic serialization, exact bytes, rich capability fallback, denied writes,
formula-safe TSV, object-URL cleanup, print cleanup, action gating, focus, and content-free errors.
The fixed response gallery owns rich and plain clipboard representations, downloads, table paste,
print-media isolation, zero network activity, mobile containment, and Chromium/Firefox/WebKit
behavior. Manual staging acceptance pastes representative output into Word, Outlook, and Excel and
reviews native print/PDF previews.

Phase 12A adds no public schema, migration `0010`, compatibility stage, feature flag, or deployment
operation. It follows the normal staging and protected production release path.
