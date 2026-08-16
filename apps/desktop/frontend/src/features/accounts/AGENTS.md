# Contents

- `SubscriptionsSettings.tsx` – lean subscription creation, browser OAuth, remaining-capacity summary, backend-owned logout/removal, HRA Cloud attachment, and account-local pending/error presentation.
- `SubscriptionsSettings.test.tsx` – static two-page product and browser-only sign-in contracts, including safe handling of retained device-code state.
- `SessionSyncSettings.tsx` – explicit encrypted-summary sync opt-in, approved-device and enrollment controls, and focused recovery-kit actions.
- `SessionSyncSettings.test.tsx` – revision fencing, transient recovery reveal, and absence-of-retirement-control evidence.

# Guidelines

- Keep credentials opaque. Display only owned account summaries and runtime-provided errors. The only Codex capacity value admitted here is the bounded renderer-owned remaining percentage; never render raw rate-limit buckets, token usage, OAuth URLs, device codes, or runtime diagnostics.
- Scope pending state and errors to one account so work on another profile stays available.
- Preserve semantic controls, focus movement, keyboard access, status announcements, readable contrast, and reduced-motion behavior.
- Keep Codex subscription rows limited to identity, bounded remaining capacity, authentication state, Add subscription, Connect, Open sign-in, Cancel, and Log out.
- Treat successful logout as a gateway-owned removal transaction. Wait for its projection instead of chaining a renderer-side removal.
- Start only browser OAuth. A retained older device-code flow may be cancelled, but its code must remain hidden.
- Always identify HRA Cloud separately from Codex subscriptions. Give configured builds an explicit text sign-in action and render an honest disabled state when the release has no usable cloud endpoint. Cloud sign-in must not imply that session sync is enabled.
- Keep Devices observation-only and explicit-consent. Render only runtime-owned device names, exceptional state, approval/revocation actions, and focused recovery controls. Never render hardware IDs, network data, vault coordinates, wrapped roots, proofs, or provider data.
- Recovery-kit plaintext may exist only in the explicit security-critical reveal response and component state until its bounded expiry. Never copy it into storage, diagnostics, snapshots, events, receipts, or ordinary settings copy.
