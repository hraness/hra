# Automatic usage settings

In current source, `hra usage auto` reads or changes this machine's automatic usage policy. A policy change does not call a provider, move an account or session, or enable an unavailable runtime capability.

Read the current configuration and its revision:

```sh
hra usage auto status
hra usage auto status codex --json
```

The default begins on. Codex and Claude each have an `inherit`, `on`, or `off` override. An inherited setting follows the default; an explicit provider override wins even when the default is off. The default is not a global kill switch. Devin has no automatic usage policy.

## Change a setting

Each change requires the revision from status and a UUID idempotency key. The following example assumes the observed revision is 1 and the example key has not previously been used on this installation:

```sh
hra usage auto off --revision 1 --idempotency-key 00000000-0000-4000-8000-000000000001
```

Use `on` or `off` without a provider to change the inherited default. Add `codex` or `claude` to change that provider's override. Use `inherit` with a provider to restore inheritance. Obtain the latest revision before each new change and use a new key:

```text
hra usage auto off codex --revision <n> --idempotency-key <uuid>
hra usage auto inherit claude --revision <n> --idempotency-key <uuid>
```

If a response is lost, replay the exact original command, including its key and revision. The response reports the configuration accepted by that request, even if later changes have occurred. Run status again to read the latest configuration. A conflicting revision changes nothing; inspect status before submitting a new request. Do not reuse a key for a different setting.

## What disabling does

Effective Codex disable suppresses new automatic reset-credit dispatches, including retries. An uncertain existing attempt retains its original key and remains recovery-pending. Disabling after durable reset admission does not cancel that provider operation or discard its result. Usage observation continues.

These controls do not yet provide automatic account movement, managed-send forwarding, or the planned browser usage view. Claude native fallback remains unavailable without its separate pinned live-acceptance proof. Existing explicit account selection is unchanged.
