# Brand System

Status: locked for v1

## Authority

**Locked**

Capstone Chat adopts **CAPSTONE Brand System v2.0.0**, released July 21, 2026, as its visual and verbal brand authority. The app-ready source is vendored in `packages/brand`; the external brand-package folder is not a runtime or build dependency.

The vendored package contains the frozen master geometry, approved SVG exports, browser and app icons, webfonts and licenses, exact CSS and JSON tokens, release provenance, and the relevant brand and voice guidance. Upstream artwork and tokens remain unchanged so that future updates can be reviewed as explicit version changes.

## Product application

**Locked**

- Figtree is the default interface and reading typeface.
- Bricolage Grotesque is reserved for prominent headings and restrained brand moments, not dense application chrome or message content.
- IBM Plex Mono is used for code, technical data, and compact structured labels where a monospaced face helps comprehension.
- Navy, white, paper, and warm white establish the primary application surfaces.
- Teal Ink is the normal accessible action, control, and link color on light surfaces. Bright Teal is limited to large controls or graphic use where contrast has been verified.
- Gold marks the most important decision or detail. It is an accent and is never normal text on white.
- The product derives component-level semantic variables from the approved brand palette instead of scattering raw color values through components.
- Interface motion uses the supplied 150 ms, 240 ms, and 520 ms durations and the supplied standard easing. Reduced-motion preferences must preserve information while removing unnecessary animation.
- UI icons use simple literal geometry, rounded terminals, and an approximately 1.8 px stroke at the reference size.

The chat interface should feel calm, clear, structured, and contemporary. Brand expression supports the conversation rather than competing with it; generous space, strong hierarchy, thin rules, and restrained accents are preferred over decorative effects.

## Theme

**Locked**

- V1 ships with one polished light theme.
- V1 does not include a theme toggle or automatic system dark-mode switching.
- Components consume semantic brand variables rather than hard-coded presentation colors, preserving a straightforward path to a later dark theme without requiring a second theme now.
- Intentional navy surfaces may use reverse brand assets but do not constitute a separate dark theme.
- Browser-native controls declare and use the light color scheme.

## Logo use

**Locked**

- The horizontal primary logo is the default full signature on light surfaces.
- The reverse signature is used on navy or another controlled dark surface.
- A compact application surface may use the symbol when the Capstone name is already established.
- The horizontal logo is never displayed below 128 px wide. The standard symbol is never displayed below 24 px; use the micro symbol at 24 px and the dedicated favicon at 16 px.
- Standard logo clear space is `0.5H`; compact navigation may use `0.25H`, where `H` is the visible symbol height.
- Logo artwork is not distorted, recolored, rotated, shadowed, redrawn, or combined with a descriptor.
- A linked logo receives one accessible name; its image content is decorative so screen readers do not announce it twice.

## Color and accessibility

**Locked**

- Capstone-controlled interfaces and rendering target WCAG 2.2 Level AA. Arbitrary model-authored wording cannot be guaranteed to satisfy every accessibility criterion.
- Every chat and administration operation is keyboard accessible and has a visible focus state.
- Color is never the only signal for state, feedback, or action.
- Focus indicators use a visible 2–3 px ring with at least 3:1 contrast and a readable offset.
- Navy on white, Gold on Navy, Teal Ink on white, and Mint on Navy are approved accessible pairings for their documented uses.
- Bright Teal on white is not used for normal-sized text. Gold on white is decorative only and never body text.
- New tones or component states must be derived from the approved palette and contrast-tested before use. A one-off feature does not introduce a new brand color.
- Sending, streaming, stopping, completion, failure, and compaction expose concise programmatic status updates for assistive technology.
- Streamed tokens are not announced individually. The answer remains normally navigable while a separate status region reports lifecycle changes.
- Streaming does not steal focus. After sending, focus remains in the composer so the employee may begin the next draft.
- Reduced-motion preferences remove unnecessary movement without hiding state changes or information.
- Browser verification includes automated accessibility checks plus manual keyboard and screen-reader checks for critical chat flows.

## Product voice

**Locked**

Capstone's voice applies to product navigation, onboarding, status, empty states, errors, and administrative copy. It does not rewrite employee prompts or force assistant answers into insurance marketing language.

Product copy is concise, calm, capable, and useful. It uses active verbs, explains the outcome or next step, introduces technical terms only when they help, and does not blame the employee. Errors state what happened, whether work was preserved, and what the employee can do next.

The voice is expert without distance, clear without oversimplifying, protective without paternalism, and contemporary without spectacle. Avoid unsupported superlatives, fear-led language, empty innovation language, and promises such as “total protection,” “zero risk,” or “always guaranteed.”

## Repository boundary

**Locked**

The chat repository includes only the reusable digital identity subset. Marketing photography, social campaigns, print templates, desktop font files, the full manual renderer, and brand release tooling remain in the upstream brand package and are not part of Capstone Chat v1.

Any later brand release is adopted deliberately: replace the vendored upstream files, preserve its metadata and licenses, verify the app visually and for contrast, and record the approved version change here.
