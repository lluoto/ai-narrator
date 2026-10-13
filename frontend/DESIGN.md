# AI Narrator Frontend Design System

## 1. Atmosphere & Identity

The interface is a compact game-master workstation: quiet, readable, and operational rather than cinematic. Its signature is ruleset-aware atmosphere without layout changes: CoC feels cold and spectral through restrained green, while D&D feels archival and martial through antique gold.

## 2. Color

### Shared semantic roles

| Role | Token | CoC 7e | D&D 5e | Usage |
|---|---|---|---|---|
| Page | `--surface-page` | `#0b1210` | `#17130c` | App background |
| Panel | `--surface-panel` | `#111b17` | `#211a0f` | Panels and previews |
| Sunken | `--surface-sunken` | `#0d1612` | `#1b150c` | Inputs and cards |
| Elevated | `--surface-elevated` | `#16231d` | `#2a2112` | Modal/elevated states |
| Text | `--text-primary` | `#d8e4dd` | `#eadfca` | Primary copy |
| Secondary | `--text-secondary` | `#a8b8af` | `#c0b091` | Secondary copy |
| Muted | `--text-muted` | `#84978d` | `#a9997e` | Metadata and hints |
| Border | `--border-default` | `#294338` | `#544225` | Dividers and controls |
| Accent | `--accent-primary` | `#78a990` | `#b38a35` | Interactive emphasis |
| Accent strong | `--accent-strong` | `#a6cfb8` | `#d4ad58` | Hover/focus |
| Accent contrast | `--accent-contrast` | `#08100c` | `#161006` | Text on accent |
| Accent soft | `--accent-soft` | `rgba(120,169,144,.12)` | `rgba(179,138,53,.12)` | Selected rows/messages |
| Track | `--track-background` | `#24312b` | `#3a301e` | HP/SAN tracks |

Status colors remain ruleset-independent: success `#2ed573`, warning `#ffa502`, error/death `#ff4757` or existing semantic red. Accent colors never replace health, sanity, warning, or error meaning.

## 3. Typography

- Primary: `Segoe UI, system-ui, sans-serif`.
- Mono: browser monospace for dice and session IDs.
- Body: `0.95rem`, line-height `1.5`; metadata: `0.65rem` to `0.8rem`; page title: `2.5rem` desktop and `2rem` compact mobile.
- Letter spacing is zero except existing compact uppercase labels (`1px`).

## 4. Spacing & Layout

- Base unit: 4px.
- Main width: 800px.
- Component spacing uses 4/8/12/16/24/32px steps.
- Full-height surfaces use `100dvh`.
- At 390px, the start screen uses compact vertical spacing and a bounded saved-session scroller so the primary CTA remains reachable without horizontal overflow.

## 5. Components

### Start screen
- Structure: title, description, character form, stat preview, saved sessions, primary CTA.
- Ruleset preview: changing the rules select updates all theme tokens immediately.
- Attribute preview follows the selected ruleset: CoC uses its eight percentile characteristics; D&D uses its six ability scores.
- States: default, focus, disabled/loading, error, saved-session hover.
- Accessibility: visible accent focus border; labels remain associated by proximity in the existing markup.

### Game shell
- Structure: status header, scene overview, suggestions, encounter/companion panels, narrative log, input footer.
- Theme source: active session ruleset, normalized to `cosmic-horror` or `dnd5e`.
- States: active tabs/buttons use accent; status colors remain semantic.

### Interactive controls
- Border radius: 6px inner controls, 8px primary controls/panels, 12px suggestion/filter chips only where already established.
- Hover: accent color/border shift. Focus: visible accent outline/border. Disabled: 40% opacity.

## 6. Motion & Interaction

- Micro transitions: 150ms ease-out for color, border, and background.
- Progress width remains 300ms.
- No decorative motion; honor reduced-motion defaults by avoiding new animation.

## 7. Depth & Surface

Strategy: tonal shifts plus restrained borders. No new shadows, glass, gradients, or decorative blobs. Depth comes from the page/panel/sunken/elevated surface ramp.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA contrast.
- Theme changes cannot alter health/error semantics.
- Primary content must not horizontally overflow at 390, 768, or 1280px.
- Keyboard focus must remain visible.

### Accepted debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| Emoji tool icons | `src/App.vue` status/companion controls | Existing UI convention; replacing iconography is outside the theme change | Replace in a dedicated icon-system task |
| Single-file CSS | `src/App.vue` | Existing architecture; splitting styles would be unrelated refactoring | Revisit when shared component tokens are extracted |
