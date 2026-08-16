# Contents

- `src/` – the typed HRA pane-chat and subscription interface, projection shell, tests, and visual styling.
- `direct/` – the browser-only deterministic HRA lab, strict fixture world, native-transport double, scenario catalog, and production-boundary check.
- `index.html` – the WebView document, metadata, and content security policy.
- `vite.config.ts` – the fixed development origin and deterministic frontend output path.

# Guidelines

- Keep this directory inside the parent Bun workspace; it intentionally has no `package.json` or lockfile.
- Load only shared standalone design tokens, reset rules, and `@hraness/ui/components.css` in the product entry. Keep design-kit React recipes, galleries, and icon packages exclusively in the separate Direct graph. Use the HRA-local React Aria adapter for the production controls and the official Vercel Streamdown renderer for streaming Markdown.
- Keep the Vite development host on `127.0.0.1:5173` because the app-owned supervisor, readiness protocol, Debug launch envelope, and navigation allowlist bind that exact origin. Do not restore the Native SDK manifest's generic dev launcher or reuse an existing listener.
- Restrict document navigation in `app.zon` and renderer connections in the HTML content security policy; they are separate controls.
- Render only HRA-owned pane and account snapshots/events. Generated Codex types, provider identifiers, local paths, login authority, account budgets, model catalogs, and process privileges stay behind the gateway.
- Permit the production renderer bridge to carry the bounded chat-pane commands, including one transient prompt, plus path-free repository and portable task operations. New-pane folder selection must use the existing Native chooser and return only a repository identifier. Keep repository URLs/paths, provider session/thread/turn commands, raw answers, private run state, and filesystem authority absent.
- Keep the renderer backend-free. Pane and subscription features use the typed Native bridge; the gateway owns SQLite, remote task-plane communication, portable task authority, and account routing.
- Keep Direct in its separate Vite graph and output directory. Production renderer source must not import it, and the production build must pass both the emitted-marker scan and the Vite module-ID guard for Hugeicons and design-kit React JavaScript.
