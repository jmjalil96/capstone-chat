# Capstone brand package

This workspace package is the approved brand source for Capstone Chat. It is a focused, app-ready extraction of **CAPSTONE Brand System v2.0.0**, released July 21, 2026. Upstream identity files are copied without modification; `src/fonts.css`, `src/index.css`, and this README are the only local adapters.

## Use in the web app

Import the font declarations and design tokens once at the application root:

```css
@import "@capstone/brand/styles.css";
```

The main families are then available through the upstream variables:

- `var(--capstone-font-body)` — Figtree for interface and reading text.
- `var(--capstone-font-display)` — Bricolage Grotesque for prominent headings and brand moments.
- `var(--capstone-font-data)` — IBM Plex Mono for code, compact labels, and structured data.

Import approved artwork from an explicit package path, for example:

```ts
import capstoneLogo from "@capstone/brand/assets/logos/capstone-primary.svg";
```

## What is included

- `src/tokens.css` and `src/tokens.json` — exact upstream color, typography, spacing, shape, and motion tokens.
- `assets/logos/` — the complete approved SVG delivery set.
- `assets/icons/` — favicon and standard browser/app icon sizes.
- `assets/fonts/` — the approved Latin WOFF2 webfonts.
- `licenses/` — the upstream SIL Open Font License texts.
- `source/logo/` — frozen canonical icon and wordmark geometry, approved lockup, checksums, and provenance. These files are retained for governance and must not be edited or imported as everyday UI assets.
- `guidelines/` — the approved brand platform and voice source.
- `upstream/` — the brand release and logo manifest metadata.

Photography, social assets, print templates, desktop fonts, the brand manual renderer, and release tooling are intentionally excluded because Capstone Chat does not need them at runtime.

## Non-negotiable rules

- Use `capstone-primary.svg` on light surfaces and `capstone-primary-reverse.svg` on navy or another controlled dark surface.
- Use the compact symbol only where the Capstone name is already clear. Use `capstone-icon-micro.svg` at 24 px and the dedicated favicon at 16 px.
- Preserve the artwork, lowercase wordmark, colors, proportions, and clear space. Never typeset or reconstruct the wordmark.
- Gold is a decisive accent, not body text on white. Teal Ink is the accessible teal for normal text and controls on white.
- Give a linked logo one accessible name and mark its internal image as decorative to avoid duplicate announcements.
- Keep the license files whenever the fonts are redistributed.

See [the locked product requirements](../../docs/prd/05-brand-system.md) for the Capstone Chat-specific application rules.

## Updating the package

Do not tweak upstream artwork or tokens in place. Replace them only from a later approved CAPSTONE brand release, retain its release metadata and licenses, and record the deliberate product decision in the PRD.
