# Contents

- `geist/` – the pinned Google Fonts Geist variable face, SIL Open Font License, and provenance used by the shared text token.
- `geist-mono/` – the pinned Geist Mono variable webfont, SIL Open Font License, and provenance used by the shared heading and code tokens.

# Guidelines

- Preserve both pinned artifacts byte-for-byte and retain each adjacent OFL and provenance record.
- Do not subset, convert, rename, recompress, or replace either face with a remote runtime dependency.
- Update `../fonts.css`, `../tokens.css`, and `../index.ts` together when browser font identities change. Add a raw font package export only for a concrete native consumer.
