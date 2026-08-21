<!-- kb:context scopes/packages-internal-design-kit-src-react--9197a7cd4c9b -->
# Contents

- Controls and fields – buttons, split actions, links, cards, text/search/number/file/select/checkbox controls, sliders, segmented/toggle choices, tabs, and shared selection conversion.
- Collections and overlays – list boxes, menus, tooltips, modals, disclosures, accordions, toolbars, and portal-theme propagation.
- Application composition – theme, shell, rail and route animation, bars and surfaces, navigation, route states, content, data charts, feedback, status, chat, and playback transport.
- Interaction infrastructure – router adaptation, icons and icon affordances, keyboard shortcuts, skip links, haptics, class composition, Jelly runtime loading, and the semantic Jelly surface bridge.
- Decorative effects – aurora/phaser fields, deterministic procedural recipes and renderers, and particle halos.
- `design-gallery.tsx`, `index.ts`, and colocated example/property/regression tests – the public export surface, executable component specification, and interaction laws.

# Guidelines

- Use native semantics for static content and ordinary links; use React Aria Components for composite focus, selection, type-ahead, dismissal, and restoration contracts. Do not reproduce those behaviors manually.
- `JellySurface` may paint an owned native or React Aria control, which remains its only interactive descendant. Never enable Jelly card `squish` around another interactive element, and keep the painted host and semantic target congruent.
- Keep recipes product-neutral and semantic-icon-agnostic. Accept consumer React nodes for meaning, use `Icon` only for package-owned glyphs, and resolve foreign callback keys against supplied items instead of asserting them into owned identifiers.
- Treat a literal title as the baseline content-intro composition. `PageIntro` eyebrows identify distinct parent scope, navigation context, or status, and descriptions add instructions, constraints, or interpretation; gallery fixtures must not present all three as decorative defaults.
- Keep `DesignThemeProvider` System-first, `data-theme` based, system-enabled, nonce-aware, transition-suppressed, and hydration-stable. A server document may retain a concrete light fallback until the blocking bootstrap resolves the preference. Fixed light or dark products may omit preference normalization; scoped product palettes that portal or replace the root must pass through `DesignPortalThemeProvider.portalClassName` and `GlobalErrorDocument.bodyClassName`.
- Require nonblank accessible names for icon-only controls, menus, list boxes, search fields, segmented controls, toolbars, and faders. Icon actions own their hover/focus tooltip through `IconButton`, `IconLink`, aria-labelled `Pressable`, or the recipe's explicit tooltip prop; tooltips never replace accessible names or become the only touch discovery path.
- Keep pending actions, playback transport, and composed controls layout-stable: state changes do not replace visible labels, reorder DOM, move focus, or change control geometry. Independent actions retain independent focus targets, and compact/default/large size contracts keep semantic and painted rectangles equal.
- Keep application rails persistent on wide screens and focus-trapped in the compact modal drawer; `navigationKey` closes the drawer after routing. Animate only changing subpage content and honor both CSS and JavaScript reduced-motion preferences.
- Preserve native landmarks and table, progress, details, heading, and link semantics. Portalled overlays retain the trigger's theme, labelled content, dismissal, containment, and focus restoration; skip-link targets are natively focusable or use `tabIndex={-1}`.
- Keep chart SVGs presentation-only when an exact semantic table or visible value list carries the data. Selectable chart rows are ordinary named buttons with stable geometry; chart motion is optional, never required to understand the final state, and must stop under reduced motion.
- Toolbars contain commands; value sliders use a separate labelled group so arrow keys have one meaning. Global shortcuts ignore composition, prevented and repeated events, and interactive controls by default; editable targets require a separate explicit opt-in.
- Preserve React Aria state attributes in shared CSS. Do not use list-box or menu semantics for static navigation, and do not server-render long React Aria collections until upstream streaming behavior is verified.
- Keep route-state diagnostics visually inert and provider-owned. `GlobalErrorDocument` may mount a consumer reporter before its visible fallback, but the design kit must not import an observability SDK or expose captured error details.
- Keep Web Haptics opt-in, best-effort, and triggered only by a real user action. Product state and task completion must never depend on haptic feedback or its verification event.
- Keep decorative canvases presentation-hidden, pointer-transparent, SSR-useful before hydration, and gated by reduced motion. `ParticleHalo` children remain visible semantic DOM.
