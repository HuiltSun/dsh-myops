# Vendored Mozilla pdf.js

- Upstream: <https://github.com/mozilla/pdf.js>
- npm package: `pdfjs-dist`
- Version: **4.10.38**
- License: Apache-2.0 (see `LICENSE` in this directory)
- Files vendored from the npm package (unmodified):
  - `legacy/build/pdf.mjs`
  - `legacy/build/pdf.worker.mjs`
- Not vendored: `cmaps/`, `standard_fonts/`, `image_decoders/`, source maps, TypeScript types.

## Why

`ops_read_pdf` uses pdf.js to extract the text layer from real-world PDFs (embedded
fonts, encrypted documents with a password, line reconstruction). It runs in Node
through pdf.js's fake worker (`legacy` build), so no separate worker process or
`workerSrc` configuration is needed.

If these files are missing or fail to load, `lib/doc-tools.mjs` falls back to the
original hand-written PDF parser and finally returns a readable `unsupported`
message instead of garbled text.

## Notes

- Only text extraction is used; no rendering/canvas (`@napi-rs/canvas` is optional
  and not needed — pdf.js prints a harmless warning when it is absent).
- `disableFontFace: true`, `isEvalSupported: false`, `verbosity: 0` are set by the
  caller.
- The vendored files are byte-identical to the npm release; no local patches.
