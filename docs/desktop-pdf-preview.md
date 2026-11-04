# Desktop PDF preview — CoreGraphics page rendering

**Current status: source implementation pending root validation.** Root alone runs checks, builds, installation and Mac acceptance. This document makes no acceptance claim.

The initial Files PDF iframe came from A's reviewed commits `6d2e177a9c6e4377935bf87479822873683c10c7` and `fe69cc12ddca10d4f341f0f27d3be4d772efc6c6`, with shared recovery wiring integrated in `839027f`. Root's installed candidate `57a3a47fe5badbf64691758931b180b4cb579d6f` passed 4,000 UI tests but failed native PDF display: a valid two-page file showed a blank white iframe, and accessibility reported `chrome-error://chromewebdata/` on repeated observation. Passing fetch/DOM tests did not establish display. Root removed that iframe candidate before authorizing this bounded renderer replacement.

## Original Rerun design

Reference remains `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/files/FilePreview.tsx` supplies the original white document surface and loading skeleton. Its raw-PDF iframe is the part that failed under the Mac policy.
- `FileDetail.tsx` and the existing `PanelEditorHeader` supply the file name and Back control.
- `useSiblingFiles.ts`, `AgentPanelFiles.tsx` and the already accepted desktop sibling navigation keep folder order, previous/next file, single-file behavior and keyboard guards.
- The desktop adapter retains the mounted board/chat and existing text/image/audio/video paths. PDF page navigation is separate from sibling-file navigation.

The replacement displays inert PNG pages in that same Files surface. It does not expose raw PDF bytes to a browser PDF plugin, render PDF-supplied HTML, or execute PDF JavaScript/actions. No Electron sandbox, context isolation, Node integration, webSecurity, global CSP or browser permission is relaxed.

## Renderer decision

The installed dependencies do not contain a PDF.js/react-pdf/MuPDF/PDFium renderer. Sharp's installed `dist/constructor.cjs` explicitly requires a separate PDF-enabled libvips for PDF input; the bundled Darwin library cannot be assumed to provide it. There is no host-installed converter fallback.

Root authorized a bundled native page helper using Apple's CoreGraphics `CGPDFDocument` / `CGContextDrawPDFPage` and ImageIO PNG output. It receives bounded bytes on stdin and numeric page/scale arguments, with no source path or URL argument. It produces an inert raster, not an interactive PDF viewer. The native helper and its packaging are owned by the native integration helper; root validates compilation, bundle identity and real page rendering.

## Confined source read

`apps/ui/lib/desktop/server/pdf-read.ts` preserves the existing own-coworker confinement pattern from `readCoworkerVideo`:

- Authenticated desktop request and desktop coworker-to-engine ownership resolution.
- Up to 16 MiB, PDF extension/header/version/EOF checks, and a bounded read. Header/EOF validation is only preliminary; the native PDF parser must still accept the document.
- Lexical relative paths; no symlink or extra hard-link access; regular files and directories owned by the current user; pinned directory/file identities checked before and after reading.
- Optional listing identity `dev:ino` refuses a replaced file.
- Shared roster/deletion queue, parent-directory validation, interrupted-edit recovery, directory revalidation and in-process claimed-name refusal before opening.

`coworker-files.ts` imports the PDF reader, binds its real `recoverInterruptedCoworkerEdits` and `claimed` closures, and re-exports it. The PDF route imports through that module. There is no copied journal implementation or second claim set, and no circular import. An accidentally unbound direct reader fails closed with 503. The direct-read regression uses a real committed-publication journal and temp hard link; it requires cleanup before opening without a preceding Files listing.

After rendering, the route rechecks the coworker's existence, deletion state and engine identity before returning the page. The browser receives only the raster of the already confined snapshot.

## Route and subprocess contract

GET `/api/desktop/agents/:agentId/files/pdf?path=...&identity=...&page=1&scale=1`:

- `path` and optional `identity` retain their existing file meanings.
- `page` is a one-based integer from 1 through 10,000; default 1.
- Public `scale` is finite and between 0.5 and 2; default 1.
- Success is `image/png`, with Content-Length, nosniff, same-origin resource policy, no-store and the existing restrictive response CSP. No raw PDF response or byte-range response is offered.
- Headers: `X-Pdf-Page`, `X-Pdf-Pages`, `X-Pdf-Width`, `X-Pdf-Height`, `X-Pdf-Page-Width`, `X-Pdf-Page-Height`. Raster width/height are actual integer pixels; page width/height describe original point dimensions.

`pdf-render.ts` runs only the absolute executable configured by the supervised runtime in `RERUN_DESKTOP_PDF_HELPER`. It does not search PATH for a converter or invoke a shell. Its explicit child environment contains only NODE_ENV=production, PATH=/usr/bin:/bin and C locale variables, not provider credentials, the engine key or app session token.

Helper protocol:

1. Numeric argv: requested page, scale.
2. Stdin: at most 16 MiB of the already read PDF.
3. Stdout: one UTF-8 JSON line `{page,pageCount,width,height,pageWidth,pageHeight}`, followed by the exact PNG bytes to EOF. No other stdout.
4. Failure: nonzero exit and bounded generic stderr, which is never returned to the user.

The parent validates requested page equality, page count, finite positive point dimensions, raster bounds, PNG signature/IHDR dimensions and terminal IEND. Invalid or partial output never becomes an image response.

## Bounds and cancellation

- At most two native renderers are admitted in one UI host. Additional requests receive a visible retryable refusal.
- Parent render deadline: eight seconds. Abort, deadline and stream-limit failures send SIGKILL and wait for process close before settling and releasing the admission slot.
- Metadata line: at most 1 KiB. Stderr: at most 4 KiB and never exposed. PNG: at most 8 MiB.
- Raster dimensions: at most 4096 per side and 8,000,000 pixels. Page count: at most 10,000.
- Native rendering starts from two pixels per PDF point multiplied by the requested scale, then fits within the raster caps. Returned dimensions remain authoritative.
- A ten-second native wall-time alarm and parent-death watcher prevent an orphan if the UI host exits before its JavaScript cleanup. Root compiled the helper and verified both paths through real subprocess tests; the parent wrapper is not a substitute for that exit path.
- These input/output/pixel/time limits do **not** claim a hard operating-system memory quota for native PDF parsing.

The UI must cancel and discard old requests on file/identity/coworker/page/zoom changes, Back, close and unmount, release Blob URLs, and display renderer errors instead of leaving a blank successful-looking page. Parsed page metadata and a downloaded PNG are not a native display acceptance result.

## Authored evidence and remaining acceptance

`pdf-render.test.ts` authors a controlled child-process regression for bytes-only input, minimal environment, split metadata, output validation, bounded concurrency, timeout, abort/reaping, failed spawn and capped output/stderr. The PDF route regression retains actual filesystem confinement and recovery, with a stubbed raster helper, and covers page/scale forwarding, inert response headers, renderer refusal and stale coworker identity. Those route fixtures are not real rendering fixtures.

Root must run the focused checks, full affected suites, typecheck/build/packaging checks and the actual native helper against a valid document. Mac acceptance must visibly show both pages of the owned two-page fixture, page changes, zoom, sibling navigation, Back/close, owner isolation and successful reopening after a full restart. The prior 4,000-test result belongs to the failed iframe candidate and cannot be reused as acceptance of this renderer.

Use only root-owned disposable coworker fixtures and recovery-backed cleanup. Do not alter live source files or credentials while authoring this slice.

## Limits

Existing own PDF preview only: no PDF import, chat result card, model input, print/download/public-link action, external app, embedded link navigation, browser-rendered fallback, text search/selection parity or password entry. Encrypted, malformed or unsupported documents receive a visible refusal. Native rendering, packaging and restart acceptance remain pending.
