# Attachments

Any chat message HRA sends to a provider may carry file and image attachments. This document is the whole contract: the record shape, the accepted types, where the bytes live, what each provider receives, the CLI surface, the hosted wire, the projection, and the exact rules a browser client must follow.

## The record

An attachment is bytes plus a presentation. The bytes are content-addressed and live out of band; a message carries only a bounded reference to them.

```ts
type AttachmentReference = {
  byteLength: number;  // 1 .. 5_242_880
  digest: string;      // lower-case hex SHA-256 of the exact bytes
  mediaType: string;   // one of the accepted media types below
  name: string;        // one file name, never a path
};
```

`src/domain/attachments.ts` owns this shape and every bound. It is reachable from the browser bundle, so it carries no dependency at all: the parsing schemas live beside it in `src/domain/attachment-schemas.ts`, and the digest is computed where the bytes live, in `src/storage/attachment-store.ts`. Nothing in a reference is a filesystem path, so a reference that crossed a device boundary can never name one.

Two media types exist for every attachment, and they are deliberately different things.

- The **canonical** media type is derived from the leading bytes alone. It is what makes the store content-addressed and what a renamed executable cannot forge. Every text-ish file canonicalizes to `text/plain`.
- The **declared** media type is what the caller says the file is. It must be consistent with the canonical one, it distinguishes text-ish files from one another (`.md` and `.csv` sniff identically), and it is what reaches the provider and the user.

### Bounds

| Constant | Value |
| --- | --- |
| `ATTACHMENT_MAX_COUNT` | 8 attachments per message |
| `ATTACHMENT_MAX_BYTES` | 5 MiB per attachment |
| `ATTACHMENT_MESSAGE_MAX_TOTAL_BYTES` | 10 MiB per message |
| `ATTACHMENT_NAME_MAX_BYTES` | 255 UTF-8 bytes per name |
| `ATTACHMENT_INLINE_TEXT_MAX_BYTES` | 64 KiB of one text file inlined into a prompt |

A name is one file name: no `/`, no `\`, no control scalar, and never `.` or `..`. A message may not repeat the same name and digest twice.

`ATTACHMENT_INLINE_TEXT_MAX_BYTES` bounds only how much of a text file is folded into the prompt. A larger text file is still stored, still named in every manifest, and still reported at its true size; the folded block says how many further bytes were not inlined.

## Accepted media types

Images: `image/png`, `image/jpeg`, `image/gif`, `image/webp`.

Text-ish: `text/plain`, `text/markdown`, `text/csv`, `application/json`. Source code is `text/plain`.

Admission is two-sided and both sides must agree.

1. **By name.** The extension must be on the reviewed list in `attachmentMediaTypeForName`. A `.dmg`, a `.so`, or an extensionless file is refused before it is ever opened.
2. **By bytes.** `sniffAttachmentBytes` reads the leading bytes: the PNG, JPEG, GIF, and RIFF/WEBP signatures, or strict UTF-8 with no C0 control scalar other than tab, newline, and carriage return. An executable renamed `innocent.txt` fails here. An `application/json` attachment must additionally parse as one JSON document.

An image's declared media type must equal its sniffed one, so `photo.png` that is really a JPEG is refused rather than silently relabelled.

Refusal reasons are closed: `EMPTY`, `TOO_LARGE`, `UNSUPPORTED_BYTES`, `MEDIA_TYPE_MISMATCH`, `INVALID_JSON`.

## Where the bytes live

Bytes never enter SQLite and never enter a message column.

`AttachmentBlobStore` (`src/storage/attachment-store.ts`) owns one mode-0700 directory, `<state root>/attachments`. Each blob is a mode-0600 file named `<digest>.<ext>`, where the extension comes from the canonical media type and is therefore itself a function of the bytes: `png`, `jpg`, `gif`, `webp`, or `txt`. The extension exists because the Codex app-server is handed a path and recognises an image by its file name.

A write goes to a private temporary name and is renamed into place, so a reader never sees a partial blob under a digest-named path. Every read re-derives the SHA-256 and refuses bytes that do not match the digest asked for: local custody is trusted for confidentiality, never for integrity.

Two durable tables (schema version 34) hold the accounting and nothing else.

```sql
attachments(digest PK, media_type, byte_length, created_at, reference_count)
message_attachments(session_id, source_id, position PK, digest, name, media_type, byte_length, created_at)
```

`attachments.media_type` is the **canonical** type, so one digest has exactly one row even when two messages declare the same bytes as `text/markdown` and `text/csv`. `message_attachments.media_type` is the **declared** type. `source_id` is the client message id the turn was dispatched under: an `attempt_…` id for a send or a steer, a `queue_…` id for a queued message. Two triggers keep `reference_count` exact, and link rows are immutable.

Per session, `MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP` (200) manifest sources are retained, oldest pruned first. A message that has been sent stores only its `messageDigest`, exactly as before; the manifest is the only durable record of what was attached, and it holds no bytes.

Custody maintenance runs after any message that actually carried attachments. It drops accounting rows nothing references any more and removes their blobs, then removes blob files local custody does not account for at all. Blobs younger than `ATTACHMENT_BLOB_SWEEP_GRACE_MS` (one hour) are never touched, so a command still in flight is safe.

## Providers

When a message has no attachments, every existing text path is byte-identical to what it was before attachments existed. Both provider tests pin that explicitly.

### Codex

The pinned Codex 0.153.2 app-server accepts these `UserInput` variants on `turn/start` and `turn/steer`, regenerated with `codex app-server generate-ts --experimental` and read from `v2/UserInput.ts`:

```
text | image | localImage | audio | localAudio | skill | mention
```

Images are supported. HRA emits `localImage`, naming the mode-0600 blob in the local content-addressed store, which is why a blob's file name carries an image extension.

There is **no file or document input item**. A text-ish attachment therefore has no content item of its own and is folded into the text item instead.

```jsonc
// hra session send s --attach diagram.png --attach notes.md "what changed?"
"input": [
  { "type": "text", "text": "what changed?\n\nAttached file: notes.md (text/markdown, 7 bytes)\n```\n# hello\n```" },
  { "type": "localImage", "path": "/…/attachments/<digest>.png" }
]
```

The fence is always longer than the longest backtick run in the file, so a Markdown attachment cannot close it early. The attachment path is re-checked as absolute and normalized at the wire boundary.

### Claude

Claude Code already speaks Anthropic content blocks, so both kinds are native. The message text is always the first block.

```jsonc
{
  "message": {
    "content": [
      { "text": "what changed?", "type": "text" },
      { "source": { "data": "<base64>", "media_type": "image/png", "type": "base64" }, "type": "image" },
      { "text": "Attached file: notes.md (text/markdown, 7 bytes)\n```\n# hello\n```", "type": "text" }
    ],
    "role": "user"
  },
  "type": "user"
}
```

Sending and steering are the same wire shape, so an attachment can ride on a steer too.

## The CLI

```
hra session send|queue|steer <session> [--attach <path>]... <message>
```

`--attach` is repeatable, accepts at most eight paths, and may appear anywhere before the message. A message word after the literal `--` delimiter is never read as an option, so `hra session send s -- --attach is a word` sends that text.

The CLI is the only place a filesystem path is resolved for an attachment. `ingestAttachments` refuses the file by extension, opens it `O_NOFOLLOW` (so a symbolic link is refused), bounds it, sniffs it, writes it into the store, and reissues the command carrying digest references. **No path ever crosses the local socket**, which is why no remote command can name one.

The daemon does not trust any of that. It re-reads each blob, re-proves its digest, re-checks the declared media type against the bytes, and re-measures the length before a provider sees anything. A reference that fails is `INVALID_INPUT` with a message naming the file, and no provider effect happens.

Failure codes the daemon can produce for a reference: `ATTACHMENT_MISSING`, `ATTACHMENT_LENGTH_MISMATCH`, and `ATTACHMENT_<refusal reason>`.

Rendering never shows bytes. `hra session show` prints, under each user message:

```
You  turn_01
  what changed?
  attached: diagram.png  image/png  1.2 KB
  attached: notes.md  text/markdown  7 B
```

A `session send`, `queue`, or `steer` result echoes the same manifest - name, media type, length, digest - and never the bytes.

## Hosted

The remote message payload is versioned. Version 1 is the exact `{kind, message}` shape that shipped before attachments existed and is still what a message with no attachment serializes to, byte for byte. Version 2 adds a manifest.

```ts
type RemoteMessagePayload = {
  attachments: {
    byteLength: number;
    data?: string;   // base64 of the exact bytes
    digest: string;
    mediaType: string;
    name: string;
  }[];
  kind: "send" | "queue" | "steer" | "send_or_steer";
  message: string;
  version: 2;
};
```

An entry with `data` is admitted exactly the way the CLI admits a file: the base64 is decoded, the bytes are sniffed against the declared media type, and the store re-derives the digest. A hosted claim about the digest is checked, never trusted. An entry with no `data` must already be in custody on the custodian machine, which is how a client re-sends a file the custodian already holds without paying for the bytes twice.

### Hosted bounds

| Constant (`remoteAttachmentLimits`) | Value |
| --- | --- |
| `count` | 8 |
| `inlineBytes` | 64 KiB per attachment |
| `totalInlineBytes` | 96 KiB per message |
| `nameCharacters` | 255 |

These exist because the whole command is one encrypted Convex document. Convex caps a document at 1 MiB and `parseEncryptedEnvelope` caps the ciphertext at `commandPayloadCiphertextCharacters` (350,000 base64url characters, about 262,000 plaintext bytes). A full 64,000-character message plus 96 KiB of inlined bytes base64-encodes to roughly 195,000 plaintext bytes and about 260,000 ciphertext characters - comfortably inside both caps, and pinned by a test.

Refusals are codes, not truncation. Parsing returns `null` for anything over a bound, which rejects the command. Materialization on the custodian returns `ATTACHMENT_MISSING`, `ATTACHMENT_LENGTH_MISMATCH`, `ATTACHMENT_DIGEST_MISMATCH`, or `ATTACHMENT_<refusal reason>`.

**What a client should do with something larger than 64 KiB.** Refuse it locally with the same bound and tell the person to attach the file from the machine running the session, with `hra session send --attach`. There is no hosted upload lane: pushing multi-megabyte bytes through an encrypted command document would breach the Convex document cap and the per-user quota, and HRA deliberately has no blob endpoint. A client may also send a `data`-less reference for a digest the custodian already holds - that is the one way a large file can be reattached remotely.

## Projection

A compact `user_message` event may carry a bounded manifest and never bytes.

```ts
attachments?: {
  byteLength: number;  // 1 .. 5 MiB
  digest: string;      // 64 hex characters
  mediaType: string;   // the closed reviewed list
  name: string;        // <= 255 characters
}[];                   // 1 .. 8 entries
```

The key is optional and absent when a message carried nothing, so an event digests byte for byte as it did before attachments existed and a projection cache written by an older build still verifies. An older reader ignores the key under the unknown-key slack rule; a newer reader still accepts unknown keys from a later writer.

A manifest is parsed as strictly as an interaction detail: the name must be bounded, terminal-safe, free of absolute paths, free of `/` and `\`, and must fail `forbiddenDetailKeyPattern` and `forbiddenSecretValuePattern`. The media type comes from the closed list. A manifest that fails any check makes the whole event unparseable rather than silently losing an attachment. An `assistant_message` never carries one.

## The contract for the browser app

1. **Build a `RemoteMessagePayload` with `version: 2`.** Send `{kind, message}` with no `version` and no `attachments` when there is nothing attached; anything else changes the byte shape of an ordinary message.
2. **Compute the digest yourself** - lower-case hex SHA-256 of the exact bytes - and send it. The custodian re-derives it and refuses a mismatch, so a wrong digest is a hard failure, not a warning.
3. **Derive the declared media type from the file name**, using the same reviewed extension list. Do not trust a browser `File.type`: a browser reports `application/octet-stream` for many text files and will happily report `image/png` for anything named `.png`.
4. **Enforce the client bounds before sending**: 8 attachments, 64 KiB inline per attachment, 96 KiB inline per message. Over any of them, refuse in the UI and say the file must be attached from the machine running the session with `hra session send --attach <path>`.
5. **Do not send `data` for a digest the custodian already holds.** Omit it and send the reference alone; if the custodian no longer holds it, the command fails with `ATTACHMENT_MISSING` and the client should resend with `data`.
6. **Paste support is a client concern.** Read the `image/*` item off the clipboard, name it something with a reviewed extension (`pasted-image.png`), and treat it exactly like a chosen file. HRA accepts no unnamed attachment.
7. **Render a manifest, never bytes.** The `attachments` array on a `user_message` event carries name, media type, size, and digest. The digest identifies the bytes; it does not fetch them. There is no endpoint that returns attachment bytes to a browser, and the app must not present one.
8. **Refuse an unreviewed type in the picker.** Accept only the extensions the reviewed list maps, so a person learns the file is unsupported before a round trip.

## Files

- `src/domain/attachments.ts` - the record, bounds, accepted types, sniffing, and prompt folding (dependency-free, browser-safe)
- `src/domain/attachment-schemas.ts` - the zod schemas that parse a reference
- `src/storage/attachment-store.ts` - the content-addressed blob store and `attachmentDigest`
- `src/storage/state-store.ts` - schema version 34, `attachments`, `message_attachments`, and their custody methods
- `src/daemon/attachment-ingest.ts` - path to custody
- `src/daemon/attachments.ts` - references back to bytes for the providers
- `src/daemon/service.ts` - send, queue, steer, queue dispatch, projection enrichment, custody sweep
- `src/codex/client.ts` - `codexTurnInput`
- `src/claude/protocol.ts` - `claudeUserLine`
- `src/cloud/payloads.ts` - the versioned remote payload
- `src/cloud/daemon-adapters.ts` - hosted materialization and the compact event body
- `src/cloud/projection.ts` - the compact manifest
- `src/cli/parser.ts`, `src/cli.ts`, `src/cli/render.ts` - the CLI surface
