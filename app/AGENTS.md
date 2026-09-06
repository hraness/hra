# Contents

- `index.html` is the only shell. It carries the mobile viewport with `viewport-fit=cover` and loads one module entry point.
- `vite.config.ts` builds the shell to `app/dist` with no inlined asset, no inlined style, and one same-origin stylesheet.
- `vercel.json` configures the second Vercel project (`app.hra.sh`) with the F1 Content Security Policy and the no-store shell headers.
- `src/hra/` re-exports the browser-safe repository modules the app is allowed to reach.
- `src/auth/` holds the Convex client, the in-memory token storage adapter, and the one-time-code sign-in screen.
- `src/custody/` holds device key generation, IndexedDB key storage, the enrollment flow, the account-key unlock context, idle lock, and presence.
- `src/data/` holds the wire parsers, the session heads and one head, the compact history walk, the subscribed compact and detail stream tails, the session metadata cache, the session and device command hooks, the device, device registry, and archived session hooks, the composer attachment state, the in-memory hold of bytes this tab sent, and the manual grid arrangement bound to this browser.
- `src/model/` holds the framework-free session model reducer, the transcript derivation, the grid and interaction view models, the manual card-order reducer, the session scheduled-task selection, the settings and device command view models and builders, the composer attachment rules and the one send-payload builder, the image downscaling arithmetic, the provider switch payload builder, and time formatting.
- `src/markdown/` holds the sanitiser and the markdown renderer.
- `src/lib/` holds the class-name helper, the cancellation helper, and the canvas image wrapper the downscaler injects.
- `src/routing/` holds the hash route model and the router hook.
- `src/components/ui/` holds the interface primitives as owned source.
- `src/components/` holds the icons, the state indicator, the streaming tail, the session card, the subagent chips, the scheduled-tasks badge, the transcript, the attachment chips, the account-login relay, and the interaction panel.
- `src/screens/` holds the grid, session, and settings screens.

# Guidelines

- Import repository source only from `src/cloud/crypto`, `src/cloud/projection`, `src/cloud/payloads`, `src/cloud/contracts`, `src/cloud/client`, and `src/domain/*`, and reach all of them through `app/src/hra/`. The other `src/cloud` modules are node-only and must never enter the bundle.
- Never write an inline style attribute or a style element. `style-src 'self'` blocks both. Express every visual through a Tailwind class.
- Never render raw HTML from projection text, and never resolve a non-https URL from it. Projection text reaches the reader only through `src/markdown/`, which removes zero-width and bidi characters, refuses every href that is not an absolute `https:` URL, and renders an image as its alt text.
- Render an image only from bytes the tab already holds. `img-src data: blob:` names no origin, so an `img` element cannot fetch anything; a projected attachment is a manifest with no bytes and renders as a chip, and a thumbnail appears only for an attachment this tab sent itself.
- Build an attachment send payload only in `src/model/attachments.ts` and a provider switch payload only in `src/model/provider-switch.ts`. Both shapes are ahead of the repository contract, both ask the repository parser whether this build accepts them, and neither is constructed anywhere else.
- Offer a device command only where the machine would accept one. `src/model/device-commands.ts` derives the pickers from the projected registry, so a machine with the kill switch set, an account that is signed out, or a machine with no project is never offered as a target, and the account-linking flow appears only behind that machine's local opt-in.
- Offer a remote decision only where the daemon will accept one. `src/model/session-view.ts` consumes only the parser-validated projected policy; `src/domain/remote-interaction-policy.ts` is the sole action-membership table shared by projection and live daemon verification. Remote answers are closed-choice user answers only; free text, Other, and MCP forms stay local.
- Never register a service worker, load an analytics script, or reference an origin outside the pinned Convex deployment.
- Never persist plaintext projection text, an authentication token, or an unwrapped account key. Tokens live in the in-memory storage adapter and the account key lives in the custody context only.
- Keep local storage to the one key `app/src/data/card-order.ts` owns, holding a bounded list of opaque session public ids for the reader's own grid arrangement. `app/src/auth/no-persistent-storage.test.ts` allowlists that module by name; a second entry needs the same argument, and nothing else in the app may name `localStorage`, `sessionStorage`, or `document.cookie`.
- Show a schedule; never offer to change one. The scheduled-task badge and the settings list read the projected device registries and expose no create, edit, or delete anywhere.
- Persist only non-extractable `CryptoKey` objects, and only in IndexedDB. A private key must never be exportable.
- Drop the account key on idle, on `Ctrl+L`, and on the first authority error from Convex.
- A browser device is never the first device on an account and never approves another device.
- Keep the reducer, the custody helpers, and the wire parsers free of React so `bun test ./app` runs them without a document.
- Parse every value that arrives from Convex from `unknown` before it reaches a component.
- Pin every new dependency to an exact version in the root `package.json` and keep it in `devDependencies`: nothing under `app/` is published.
