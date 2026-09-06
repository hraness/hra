# Retired Devin integration

Devin is not a supported HRA provider. HRA no longer launches its CLI,
starts or resumes its sessions, offers it in provider selection, or reports
unknown account allowance as a usable quota integration.

The supported Devin CLI and ACP interfaces report session consumption and
context usage, not verified remaining subscription allowance and reset times.
Devin's own billing dashboard shows quotas, and enterprise billing APIs exist,
but neither establishes a supported quota read through an ordinary CLI account's
provider-owned login. See the [CLI reference](https://docs.devin.ai/cli/reference/commands)
and [usage documentation](https://docs.devin.ai/admin/billing/usage).

## Existing local data

The v39 migration and historical provider tags remain readable. HRA preserves
existing Devin sessions, transcript events, usage facts, reviewed runtime
profiles, and unsettled authority records. It never treats a historical Devin
row's legacy Codex shadow column as Codex execution authority. Retired sessions
are read-only and cannot accept turns, approvals, scheduled work, or provider
switches.

HRA does not delete or inspect existing provider-owned credentials or profile
directories. It no longer creates Devin HOME or XDG directories for new
profiles. Removing HRA's integration does not uninstall a separately installed
Devin CLI.

## Unsettled login cleanup

A historical foreground login grant remains a safety fence until explicitly
resolved. Inspect it locally:

```sh
hra account show <profile> --provider devin --json
```

This reports retirement and any exact pending launch fence, without launching
Devin or reading authentication. If a grant remains, first confirm its original
child exited. Then run the exact `abandonCommand` returned by inspection. The
cleanup-only command binds the account, attempt, idempotency key, and provider
generation and requires `--acknowledge-child-exited`.

Abandonment releases only HRA's local login fence. It does not kill a process,
prove sign-in, retry an effect, or read, change, or delete credentials. Uncertain
session effects remain recorded; removal does not invent successful completion.
