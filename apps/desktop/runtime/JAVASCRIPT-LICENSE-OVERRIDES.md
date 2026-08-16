# JavaScript license override provenance

The shipped JavaScript inventory normally accepts only verbatim root
`LICENSE`, `LICENCE`, `COPYING`, `NOTICE`, copyright, and third-party license
files from each installed package. The following pinned packages omit those
files from their published package root. Packaging fails unless their exact
package metadata and the reviewed replacement documents remain byte-identical.

| Installed package | package.json SHA-256 | Reviewed document | Source |
| --- | --- | --- | --- |
| `@openai/codex@0.144.6` | `b701b7d7b7683263e5612e612c468c526d78c3deb1360741e976dc40e0456919` | `CODEX-LICENSE.txt`, `CODEX-NOTICE.txt` | `openai/codex` tag `rust-v0.144.6`, commit `5d1fbf26c43abc65a203928b2e31561cb039e06d` |
| `@openai/codex@0.144.6-darwin-arm64` | `051cbc20f48e7bd20b89e301ffc8f60af890a1da3815e5e700f11ada41c3b445` | `CODEX-LICENSE.txt`, `CODEX-NOTICE.txt` | `openai/codex` tag `rust-v0.144.6`, commit `5d1fbf26c43abc65a203928b2e31561cb039e06d` |
| `client-only@0.0.1` | `4d6342705767832f299b9a59c28e4275bcf02db19472732f93f67d979441df8f` | `SPDX-MIT-LICENSE.txt` | Published manifest declares `MIT` but provides no repository, license file, or copyright notice; canonical SPDX MIT text from `spdx/license-list-data` commit `5bf6d9610255540bfbee6890765a616042bf1e11` |

Each override is also bound to its exact Bun lock locator and integrity:

- `@openai/codex`: `sha512-wk+2CWiBNXiJLBoN2D08N9RceWkSBnlgk5g2K1a4CXrP/C0gdlHyRUG7RFzm9y41DCK/7tvCct233JVxyFmznw==`
- `@openai/codex-darwin-arm64`: `sha512-6zgvh70MzBNSeT17HEhSOrmmGGZGAKzSC7x6JAq+edkJkdPYA9P0I1tG7aJ49GlBkBxuC+MKBH1qm6+2Cghcww==`
- `client-only`: `sha512-IV3Ou0jSMzZrd3pZ48nLkT9DA7Ag1pnPzaiQhpW7c3RbcqqzvzzVu+L8gfqMp/8IM2MQtSiqaCxrrcfu8I8rMA==`

`khroma@2.1.0` has the inverse metadata defect: its published manifest omits
the license identifier, but its root `license` file contains the exact MIT
text. The installed manifest SHA-256 is
`0d2145738d3cab828da4c5724b45e0dd2577c0ce84503c956d76897e93fa7de2`;
the license SHA-256 is
`66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49`.
Both files match tag `v2.1.0`, commit
`4968165afb0d3d09be66497e7985a34f7bfe6d42` of
`fabiospampinato/khroma`. The `khroma` lock integrity is
`sha512-Ls993zuzfayK269Svk9hzpeGUKob/sIgZzyHYdjQoAdQetRKpOLj+k/QQQ/6Qi0Yz65mlROrfd+Ev+1+7dz9Kw==`.

Reviewed document SHA-256 values:

- `CODEX-LICENSE.txt`: `d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc`
- `CODEX-NOTICE.txt`: `9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915`
- `SPDX-MIT-LICENSE.txt`: `b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5`
