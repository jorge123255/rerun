# Desktop PDF text selection and Find

The original Rerun file preview at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` (`apps/ui/components/files/FilePreview.tsx`) rendered a PDF with the browser viewer:

```tsx
if (kind === 'pdf') return <iframe src={rawUrl} title={fileName} className="h-full w-full bg-white" />
```

Text selection and Find came from that viewer. This lane does not bring the iframe back. The Mac preview keeps the PNG page from `apps/desktop/native/render-pdf.c` (`kCGPDFCropBox`, `CGPDFPageGetRotationAngle`, `CGPDFPageGetDrawingTransform`) and paints a text layer in that same displayed box.

`readCoworkerPdf` in `apps/ui/lib/desktop/server/pdf-read.ts` is reused and was not edited. `coworker-files.ts` already binds it. The private writer and the shared-files lane were not edited.

The lane and integration helper did not run checks, typecheck, lint, helper compilation, packaging, or Mac acceptance. Root owns those checks.

Root integration now wires the helper into packaging, manifest validation and the UI environment. The packaged-runtime verifier invokes it against upright, rotated/cropped and scanned fixture pages. A SHA-256 header binds extraction to the exact bytes rendered by the page route: in-place replacement of a PDF cannot leave cached text over a different page image. A changed raster hash discards the old text layer. Search jumps to its first match; partial highlights and transparent selection spans follow page rotation, and copying across runs preserves source whitespace. Actual glyph placement and native selection still require root's Mac checks; partial-word highlights remain proportional within each word box rather than per-glyph outlines.

## Helper protocol

`rerun-pdf-text` reads one PDF on stdin. `argc` must be 1. It does not open a path.

Success writes one compact JSON object plus a newline and exits 0. There is no PNG. Failure writes only `Cannot read PDF text.\n` to the original stderr and exits 1. Encrypted documents fail. There is no OCR and no network.

```json
{"pageCount":2,"truncated":false,"reason":"","pages":[{"page":1,"rotation":0,"crop":{"x":0,"y":0,"width":612,"height":792},"pageWidth":612,"pageHeight":792,"text":"Alpha one","runs":[{"start":0,"end":5,"x":0.1,"y":0.2,"w":0.2,"h":0.03}]}]}
```

`pageCount` is the document page count. `pages` is a prefix. `truncated` is false only when every page is included and `reason` is `""`. Otherwise `reason` is `text`, `runs`, `pages`, or `output`. A document with more than 10000 pages fails the process instead of returning `pages`. A finished document of exactly 10000 pages is not marked truncated for that reason alone.

`start` and `end` are UTF-16 indexes into `text`, matching `NSString.length` and a JavaScript string. `x`, `y`, `w`, and `h` are fractions of the displayed page, origin at the top left. `pageWidth` and `pageHeight` are the crop after rotation: a 90° or 270° page swaps width and height.

PDFKit `characterBoundsAtIndex` is treated as unrotated PDF user space. The helper maps each run through `CGPDFPageGetDrawingTransform(page, kCGPDFCropBox, dest, 0, true)` and does not also apply `PDFPage transformForBox`. If a native check shows the bounds are already rotated, only that mapping in `apps/desktop/native/pdf-text.m` should change.

Whitespace ends a run and stays in `text` without a box. A box thinner than 0.0005 in either axis is dropped. A Find hit that covers part of a run splits that run in proportion to the UTF-16 span (`desktopPdfTextRunSlice`). A hit that covers a whole run uses the run box.

## Limits

| Limit | Value |
| --- | --- |
| PDF bytes | 16 MiB, unchanged, stdin only |
| Helper stdout | 2 MiB, then trailing pages are dropped with `reason: "output"` |
| JSON response | 2 MiB + 4 KiB for identity and path |
| Pages | 10000; above that the helper exits 1 |
| Characters | 500000 document, 100000 page |
| Runs | 8000 document, 2000 page |
| Query | 200 UTF-16 units |
| Matches | 500, then the count shows `+` |
| Parent deadline | 8 s, then SIGKILL |
| Helper alarm | 10 s |
| Concurrent extractors | 2, separate from the PNG renderers |
| Stderr retained | 4 KiB, never returned |
| Point size | above 0 and at most 14400 |

These caps are not an operating-system memory quota. The parent spawns with `shell: false`, `cwd: '/'`, argv `[]`, and env only `NODE_ENV`, `PATH` (`/usr/bin:/bin`), `LANG`, and `LC_ALL`. The env key is `RERUN_DESKTOP_PDF_TEXT_HELPER` and the value must be absolute. A missing helper is 503 `PDF text is unavailable. Reopen the app and try again.`

## Route

`GET /api/desktop/agents/:agentId/files/pdf-text` accepts only `path`, the displayed raster's `sha256`, and an optional `identity`. It calls `readCoworkerPdf` from `@/lib/desktop/server/coworker-files`, verifies those bytes have the requested hash, then calls `extractDesktopPdfText`. Both raster and text responses carry `x-pdf-sha256`. The JSON `identity` and `path` are the reader’s values. The helper never sees the path.

The response is `application/json; charset=utf-8` with `nosniff`, `content-security-policy: default-src 'none'; sandbox`, `cross-origin-resource-policy: same-origin`, and `cache-control: no-store`. A changed identity is the reader’s 409. A cancel before the read, or during extraction, is 499 `PDF text was closed.` A cancel inside `readCoworkerPdf` still uses that function’s existing 499, `PDF preview was closed.`

The preview fetches this route only after the PNG response includes both `x-pdf-page-width` and `x-pdf-page-height`. Those values may be decimals. If either header is absent, the PNG still shows and no text request is made. Zoom does not refetch text. Page changes keep the document and the active match. File, owner, and close still remount the preview. An in-flight extract is aborted. A body whose identity or path is not the open file is discarded.

Find is local. It folds `A–Z` only, so indexes stay the same length. Enter is the next match. Shift+Enter is the previous match. Match buttons are `Previous match` and `Next match`. A scanned or otherwise textless page says `No searchable text` even if a query is typed. A truncated extract that does not yet contain a word says `Search covers only part of this PDF.` A query with no hit says `No matches`. Text failures use `role="status"` and leave the page image up.

## Fixtures

`scripts/desktop/pdf-text-fixture.mjs` builds three PDFs for a native run. It is not called by packaging.

- `uprightTextPdf`: rotation 0, crop `{x:0,y:0,width:612,height:792}`, displayed 612 by 792, text contains `Alpha one`.
- `rotatedCroppedPdf`: rotation 90, crop `{x:36,y:36,width:540,height:720}`, displayed 720 by 540, text contains `Alpha two`.
- `scannedPdf`: a paint-only page, `text` `""`, `runs` `[]`, `truncated` false. That is the no-searchable-text result. It is not a failed extract and it is not OCR.
- `mixedPdf`: those three pages in one document. Page identity must follow that order.

Exact glyph boxes are not specified here. A fetched JSON payload or a DOM layer is not native alignment.

## Root wiring (now integrated; root execution pending)

The integration includes these fragments. They are recorded here for the source-to-runtime map.

`scripts/desktop/package.mjs`, immediately after `stage-pdf-helper.mjs`:

```js
await stage('stage-pdf-text.mjs')
```

Run the text stage only after the PNG helper stage, on a clean committed tree. Both scripts share `runtime/pdf-helper` and `desktop-build.json`. `sourceStamp()` refuses a dirty tracked tree. The text stage removes that stamp, writes `rerun-pdf-text` beside `rerun-render-pdf`, and writes the same stamp back. Darwin arm64 only.

Compile line used by `scripts/desktop/stage-pdf-text.mjs`:

```text
/usr/bin/xcrun clang -fobjc-arc -Wall -Wextra -Werror -O2 -arch arm64 -mmacosx-version-min=12.0 apps/desktop/native/pdf-text.m -framework Foundation -framework PDFKit -framework CoreGraphics -o <resources>/runtime/pdf-helper/rerun-pdf-text
```

`scripts/desktop/write-manifest.mjs`, next to `pdfHelperPath`:

```js
pdfTextHelperPath: 'runtime/pdf-helper/rerun-pdf-text',
```

`apps/desktop/src/main/runtime.mjs`, add `'pdfTextHelperPath'` to the `loadBundle` field list.

`scripts/desktop/verify-runtime.mjs` includes `'pdfTextHelperPath'` in the manifest field list and invokes `verifyPdfTextHelper` from `pdf-text-probe.mjs`. That bounded probe pipes `mixedPdf()` into the binary with argv `[]` and checks the geometry above.

`apps/desktop/src/main/supervisor.mjs`, on the UI spawn env next to `RERUN_DESKTOP_PDF_HELPER`:

```js
RERUN_DESKTOP_PDF_TEXT_HELPER: this.bundle.pdfTextHelperPath,
```

## Exported interface

`@/lib/desktop/pdf-text` (safe for the client): `parseDesktopPdfTextExtract`, `desktopPdfTextOf`, `findDesktopPdfText`, `desktopPdfTextSearchable`, `desktopPdfTextRunSlice`, `desktopPdfSamePointSize`, `desktopPdfFindMessage`, `lexicalDesktopPdfPath`, and the `DESKTOP_PDF_TEXT_MAX_*` constants. Types: `DesktopPdfTextExtract`, `DesktopPdfTextDocument`, `DesktopPdfTextPage`, `DesktopPdfTextRun`, `DesktopPdfTextMatch`, `DesktopPdfTextReason`.

`@/lib/desktop/server/pdf-text`: `extractDesktopPdfText(bytes, { signal })`, `DESKTOP_PDF_TEXT_TIMEOUT_MS`.

UI: `DesktopFilePdfFind`, `DesktopFilePdfTextLayer`. `DesktopFilePdfPreview` props are unchanged (`chrome` `files` or `body`).

## Limitations

- No OCR, no remote service, and no PDF or extracted text is uploaded to a model.
- Selection is the positioned runs. Spaces between runs are in `text` but have no box.
- A page whose displayed size does not match the PNG headers shows `This page’s text does not match the displayed page.` and no layer.
- Text is not retried by the page Retry button. Close and open the file to read it again.
- The helper was not compiled. `-Werror` may still reject it.
- Checks and Mac acceptance were not run.
