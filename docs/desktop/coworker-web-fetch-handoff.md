# Agent H / E2: public web_fetch — integrated source handoff

Source handoff only. Agent H's prepared base was 927c5e17da6b6db84657261695a98e0533b264de on desktop/coworker-web-fetch. Its committed implementation (181d467cefcc2adfac0b5f6a40ce80bc3fd81e1a and 406f35aac90e123021202741cecd790f101e9b6d) was cherry-picked into the coding worktree as 324b67b and f8f652b. Root integration and parser corrections described below are source changes awaiting root checks and Mac acceptance; they do not establish a working installed build.

The original lane's untracked apps/engine/src/net/ and apps/engine/src/tools/builtin/web-fetch.ts are separate alternate implementations. They were not included or substituted for the reviewed implementation. Preserve them in the author worktree; do not blindly add them to a follow-up commit.

## Original sources read

- Original Rerun reference: a6d63a4b542674ddd002e51b39ba0df6e0807bcc.
- apps/engine/src/tools/builtin/web.ts: web_fetch input { url, raw }, description, User-Agent, served facts, status caveats and 50,000-character presentation.
- apps/engine/src/tools/builtin/page-facts.ts and page-facts.test.ts: title, description, canonical, robots, language, hreflang, JSON-LD types, h1 and navigation/footer links. The original expected fact labels and fixtures are retained, but the extractor is no longer an unchanged copy: root's correction replaces unsafe repeated regular-expression scans with bounded parsing.
- apps/ui/lib/net/public-fetch.ts: reference only, not imported. Its separate validation/fetch DNS and replacement cancellation signal are unsuitable for this boundary.
- apps/ui/components/chat/SubRunTree.tsx: original web_fetch Reading activity label. Existing contract display labels remain Fetch Page and Reading a page.
- Agent H read apps/ui/AGENTS.md and the installed Next.js route documentation. The final fetch implementation is engine-side Node code; it adds no Next route.

## Current engine placement and root wiring

The implementation and its authored regressions now live in apps/engine/src/desktop/web-fetch/: index, transport, body, public-url and page-facts, plus the new html-tokens.ts parser. Local imports use .js paths. The former apps/ui/lib/desktop/server/web-fetch/ directory was removed, and its server-only imports/mocks were removed during relocation. There is no UI dispatcher dependency.

apps/engine/src/desktop/web-fetch-tool.ts exports desktopWebFetchTools(ctx). apps/engine/src/tools/registry.ts includes that adapter only in its desktop tool branch. The adapter uses the AI SDK tool definition with webFetchInputSchema and webFetchDescription, exposes only the original name web_fetch, and obtains the coworker identity from RunContext rather than model arguments. Its input remains { url: string, raw?: boolean }.

packages/contracts/src/desktop-tool-grants.ts now includes webFetch, denied by default through desktopRerunGrantsOf, as a supported TOP-LEVEL Read public web pages entry. It is deliberately not a child beneath the unavailable web row, which the current Tools UI would not display. The separate pending web row still covers Rerun web_search and download. Native Codex webSearch stays independent.

The adapter requires an active cancellation signal, preferring ctx.abortSignal because Codex's bridged execute options can omit their signal. It holds a desktop work lease through the request. Every permission callback takes a short withAgentLock, checks lifecycle and uses requireDesktopToolGrant against current persisted enabled/grant state for the exact coworker. Network I/O does not hold that config lock. Permission is read before the request, around DNS, at each redirect and before releasing a completed body. Cached exposure of the tool is not permission to invoke it after revocation.

executeWebFetch returns a structured internal result with text, failed, untrusted and observed response metadata. The adapter returns result.text on success and THROWS on failed results, matching engine/provider failure handling. A UI { type: 'error-text' } object is not an execution envelope and is not returned by this adapter. The result remains the same call's tool-role output; fetched data is never appended to system/developer instructions.

Root's desktop tool instruction now explains served HTML, untrusted source material, source citation and the absence of saved pages/search/downloads. apps/ui/lib/desktop/tool-presentation.ts previews web_fetch input through the existing sanitized text(input.url). Existing tool activity and Run Details render sanitized text and truthful failure state. Raw HTML is never rendered as markup. No new panel or duplicate chat presentation is supplied.

## Parser correction

The copied regular expressions could repeatedly scan a malformed HTML suffix and block the engine before its asynchronous deadline could fire. html-tokens.ts now advances a forward cursor through tags, quoted attributes, comments and raw script/style bodies. It limits HTML to 1,000,000 characters, 20,000 tokens and 128 attributes per tag, failing explicitly instead of publishing partial facts. Script/style contents and comments do not manufacture visible facts. ASCII-only case folding preserves source offsets for Unicode text.

page-facts.ts keeps original fact labels/order and served/rendered distinctions, uses sets for link grouping and iteratively walks JSON-LD arrays/@graph with a 50,000-node inspection limit. It does not execute scripts or claim browser-rendered content. Parser refusals retain observed HTTP status and final URL through PageReadError. New authored regressions cover repeated malformed openers, excessive tokens/attributes, unclosed raw bodies, quoted angle brackets, expanding Unicode lowercase, deep JSON-LD and preserved fixture output.

## Desktop differences and limits

- Node HTTP(S) GET connects directly to one validated numeric address. Original hostname remains HTTP Host and TLS servername/certificate identity, with explicit rejectUnauthorized and checkServerIdentity. No second DNS lookup, connection pool, proxy, cookies, authorization, app credentials, hub fallback or scripts. Every redirect revalidates its URL and all DNS answers. IP literals use the same policy. Private/reserved/mapped/transition addresses and mixed public/private DNS answers fail closed. Only ports 80/443; conservative rejection of trailing-dot/local/internal hosts; URL length at most 8,192 characters.
- At most three redirects and a 30-second total deadline across permission reads, DNS, headers and body, composed with run cancellation. A late DNS result cannot initiate a cancelled connection. Bounded synchronous parsing prevents malformed-input suffix rescans; it is not browser rendering.
- Actual streaming cap 1,000,000 bytes, with Content-Length only an early rejection. No partial body/facts on overflow. Explicit HTML/plain/Markdown/CSV/JSON/XML MIME allowlist; identity encoding only; compressed/binary bodies refused. Headers capped at 16 KiB. TextDecoder handles the declared charset; unsupported encodings fail truthfully.
- Original 50,000-character presentation cap covers facts plus body and marks truncation. All HTTP statuses >=400 remain failures with original status caveats. Received status/final URL survive content-type, body and parser failures. Page content and error reasons are normalized and JSON quoted as untrusted data. This does not make hostile page claims trustworthy.
- No .rerun/pages writeback, Saved whole promise, workspace mutation, rendered fallback, hub request, Rerun search or arbitrary download. E2 remains partial for search and real-file writeback.

## Authored regressions and acceptance boundary

Relocated offline sources cover URL/address policy, mixed DNS, validated-IP connection options and TLS identity, redirect limits/private destinations, streaming byte caps, content/encoding refusal, stalled-body/late-DNS cancellation, grant revocation, total deadlines, original served facts and truthful HTTP failure metadata. The parser regression additions are described above.

apps/engine/src/desktop/web-fetch-tool.test.ts additionally covers default denial, stale grant/disabled calls, queued revocation, revocation during a read without retaining the config lock, Stop via RunContext, lifecycle refusal, plain tool-output text and thrown HTTP failures. These are authored source, not acceptance evidence.

Agent H and the integration helper have not run tests, type checks, lint, builds, packaging, installs, network/tool/model requests or native Mac/restart checks. Root owns every execution and acceptance decision. Root checks for this integrated engine placement were still pending when this handoff was updated. Before acceptance, root must verify permitted Codex use, denial/revocation, Stop and the installed Mac path with truthful source/result presentation.
