# ripgrep provenance

The OpenAI Codex platform package bundles ripgrep `15.1.0` for Apple Silicon
macOS but retains only the executable from the upstream archive. HRA restores
the license files present in that exact upstream tag.

- Upstream repository: `https://github.com/BurntSushi/ripgrep`
- Upstream tag: `15.1.0`
- Upstream commit: `af60c2de9d85e7f3d81c78601669468cf02dabab`
- Bundled version revision: `af60c2de9d`
- Bundled binary SHA-256: `4fdf1d8365af224bc70e3c1490d8461d859c37cc70e739a11e987af0215f3e94`
- Upstream `COPYING` SHA-256: `01c266bced4a434da0051174d6bee16a4c82cf634e2679b6155d40d75012390f`
- Upstream `LICENSE-MIT` SHA-256: `0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f`
- Upstream `UNLICENSE` SHA-256: `7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c`

The bundled executable reports PCRE2 `10.45` with JIT support. The adjacent
`PCRE2-LICENCE.md` is the exact license from upstream tag `pcre2-10.45`, commit
`2dce7761b1831fd3f82a9c2bd5476259d945da4d`, SHA-256
`9cf7ac6976099a1d856826d3ef1b093bd6b84489dc6100628ac79e740cf9885a`.
