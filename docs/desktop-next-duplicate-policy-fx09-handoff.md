# FX09 — Duplicate grant/credential SOURCE vs SPEC evidence packet

Lane: Agent 7 / FX09 (+ t31u). Worktree `next-duplicate-policy-fx09`, branch `desktop/next-duplicate-policy-fx09`.
Base HEAD: `8297fe6404caa114dcb0c2cd6006291a8abb2038` (verified before editing; tree clean).
Implementation tip: `cfee01b336ede0bc6bf054b7af19929f6f2fb349`. Handoff committed separately.

**Enforcement: WAITING — explicit user decision still open.** This packet ships evidence and an inert option matrix only. No duplicate/import behavior was changed, no grant enum touched, no policy invented or enforced.

**No checks executed.** No tests, typecheck, lint, build, install, fixtures, provider/network, UI, DB, Keychain, or restart was run. The authored matrix test is unrun source.

## What the register asked

`docs/desktop-parity-full-register-20261106.md:96` (FX09): "Reconcile direct Duplicate permission/enabled/env/MCP copying with the later fresh-copy/import rule. Portable imports already reset access. Specify the intended duplicate policy and enforce it without erasing accepted independent chats." The t31u discrepancy is recorded in master docs (citations below): same-box Duplicate inherits config grants today while the recorded user requirement says copies/imports must not inherit grants; the `.env`/`mcp/`/credential **file** copy question is a separate, still-open root product decision.

## SOURCE evidence — what Duplicate actually copies today

All citations are this worktree at base `8297fe64` unless marked upstream `2a57fa6`.

### Entry points

- `apps/engine/src/http/routes/agents.ts:89-94` — `POST /agents/:id/duplicate`; on `desktopApp()` requires `x-rerun-duplicate-id` UUID header.
- `apps/ui/lib/desktop/server/coworker-duplicate.ts` — roster authority: `duplicateDesktopCoworker` writes a `desktop_duplicates` receipt, calls engine `duplicateAgent(engineAgentId, {name, displayName}, requestId)`, then inserts the `desktop_agents` row with `enabled` read back from the **completed copy's** `config.enabled` (comment line ~45: "The original duplicate preserves enabled along with the rest of its configuration"). `reconcileDesktopDuplicates` replays pending receipts — copies are durable from the placement click.
- `apps/engine/src/agents/duplicate.ts` — desktop variant: deterministic `copy-${requestId}` id, `readCopyReceipt`/`writeCopyReceipt` idempotency (`.desktop-duplicate.json` marker inside the copy folder), `withKeyedLock('desktop-duplicate:…')`, `beginDesktopAgentWork` lifecycle, `copyDesktopFiles` consistent file-group copy (no source checkpoint, no embedding on desktop: `reindexMemories(id, { embed: !desktop })`). Without a requestId it falls back to `makeCopy(newId(), …, false)` — the upstream `cp` path — **same copy semantics either way**.
- `apps/engine/src/desktop/duplicate.ts` — receipt + crash-safe file copy mechanics only; no policy.

### What travels (DUPLICATE_ROOTS)

`apps/engine/src/agents/duplicate.ts` (same roots as upstream `agents/duplicate.ts:29`):

```
DUPLICATE_ROOTS = [...ARCHIVE_ROOTS, 'mcp']
ARCHIVE_ROOTS = ['SOUL.md','INSTALL.md','config.json','.env','skills','schedules','triggers','workspace','memory','data/agent.db']   (upstream archive.ts:37)
```

Verbatim copies, per upstream `duplicate.ts` comments and code:

| Aspect | Behavior on Duplicate | Citation |
|---|---|---|
| `config.json` grants | **Inherited verbatim.** `tools.desktopToolGrants`, `tools.desktopCodexGrants`, `tools.desktopWorkspaceRead`, tool enables all live in `config.json` (`packages/contracts/src/agent.ts:55`, `desktop-tool-grants.ts`); `readStagedConfig` returns `{...parsed, name, displayName, setup:{…sessionId:null}}` with no grant stripping. Grant checks re-read config per call, so the copy is privileged immediately. | `duplicate.ts:70-85`; upstream `duplicate.ts:84` |
| `enabled` / `ephemeral` / kind | Inherited verbatim from config; roster `enabled` mirrors `detail.config.enabled`. | `duplicate.ts:84`; `coworker-duplicate.ts` publishCopy |
| `.env` values | **Inherited verbatim** (keys AND values), rewritten only for 0600 mode. Upstream comment: deliberate — "a copy that arrived signed out of everything would not be a duplicate." | `duplicate.ts:118,130-132`; upstream `duplicate.ts:19-25` |
| `mcp/` OAuth bundles | **Inherited.** `mcp/` is added to DUPLICATE_ROOTS only for duplicate; "no archive may ever do" this. | `duplicate.ts:27-29` |
| `config.mcpServers` env/headers literals | **Inherited verbatim** — no `scrubConfig` on this path (scrub exists only in archive.ts). | `duplicate.ts` (no scrub call); upstream `archive.ts:124-153` for contrast |
| connectionId / provider / model | **Inherited** — comment: "they name this box, and this is the box." | `duplicate.ts:81-84` |
| `data/agent.db` (private coworker DB) | **Inherited** — byte-consistent copy of db+wal+journal on desktop path. Records created via `db`/`sharedDb`-adjacent private tools travel. | DUPLICATE_ROOTS; `desktop/duplicate.ts` `copyGroup` |
| `memory/*.md` | Inherited; index rebuilt (`reindexMemories`, embed skipped on desktop). | `duplicate.ts:150` |
| `schedules/` | Inherited; cron rebaselined (`lastRunAt` reset so nothing fires on arrival), **schedule models kept** (`clearModel=false`). | `duplicate.ts:134`; upstream `import.ts:204-216` |
| `triggers/` | Tokens **always reminted** ("two triggers answering to the same secret is at best an ambiguous URL"), trigger **models kept** on duplicate (`clearModel=false`). | `duplicate.ts:135`; upstream `import.ts:219-240` |
| `setup` | Kept except `sessionId: null` — copy does not inherit the source's install conversation. | `duplicate.ts:84` |
| agent id inside MCP headers/env/args/url | Rebound source→copy id (`rebindAgentId`), so hub calls attribute to the copy. | `duplicate.ts:41-55` |
| chats / sessions / runs / system.db | **NOT inherited** — `system.db` (sessions, messages, runs, agent index) is outside agent-dir roots; the copy is a new engine agent with no transcript. Accepted independent chats are structurally preserved. | `db/repos/{sessions,messages,runs}.ts` → `getSystemDb`; upstream `duplicate.ts:19-25` |
| request_secret values, MCP secret references, desktop roster/session/draft state | **NOT inherited** — stored in the UI-side desktop DB (`apps/ui/lib/desktop/server/secret-requests/store.ts`, `mcp-secret-references/store.ts`), outside engine agent roots. | file locations above |

### Supplement check

`upstream-pr38-review-20261106` @ `ab3def9` — `apps/engine/src/agents/duplicate.ts` is **byte-identical** to `2a57fa6` (diff verified). No later upstream change to duplicate semantics.

## SPEC evidence — the recorded requirement and reset rules

Master records (read-only, `round38-master-completion`):

- `docs/desktop-round38-master-inventory.md:126` — "Same-box Duplicate currently inherits config grants; portable import forces grants off. User t18u no-inherited-grants on copies/imports recorded as root discrepancy (not overridden by audit product-decision label)."
- `docs/desktop-round42-handoff.md:66` — "Duplicate grants | SOURCE/SPEC discrepancy (t31u): inheritance vs import/copy wording — root reconciles; no clone-semantics change in docs; no outside-task quote as final instruction; preserve import restrictions."
- `docs/desktop-round42-release-readiness.md:29,50` — "Imports create fresh identities: no inherited chats, credentials, connections, or grants." / "**t31u:** grant/credential inheritance is a SOURCE/SPEC discrepancy for root … Root separately decides `.env`/`mcp`/credential **file** copy semantics. Preserve `.rerun*` / `.rerun-skill-*` exclusion and ordinary hidden files."
- `docs/desktop-round42-root-verification-matrix.md:92` (DUP-G1) — "**User requirement:** copy/import must not inherit grants. After root decision, Duplicate must not leave tool grants on. Credential/`.env`/`mcp/` copy policy is a **separate** root product choice."
- `docs/desktop-parity-runtime-coverage-20261106.md:117` — same discrepancy restated; "do not broaden portable imports."

### The "later fresh-copy/import reset" rules already in tree

Two reset paths exist today; neither is the Duplicate path:

1. **Upstream archive → import** (`apps/engine/src/agents/archive.ts`, `import.ts`; upstream `2a57fa6`, same in this tree):
   - `.env`: keys kept, **every value cleared** (`archive.ts:223-231` `redactionFor`).
   - `config.json`: `scrubConfig` replaces literal secrets in `mcpServers.env`/`headers` with `${RERUN_SVC_*}` references, nulls `connectionId` (`archive.ts:124-153`). Note: `scrubConfig` does **not** touch `tools.*` grants — upstream has no desktop grants; on this tree the desktop portable path is what strips them.
   - `workspace/.rerun/services.json`: connector registry redacted — oauth/managed → `needs_auth`, envKeys → `needs_config`, owner account labels/emails removed (`archive.ts` `redactRegistry`).
   - `triggers/*.md`: webhook secret dropped, copy gets its own URL (`redactTriggerForArchive`).
   - `mcp/` is **not** in ARCHIVE_ROOTS — OAuth bundles never leave the box.
   - Import side (`import.ts`): `connectionId`/`provider`/`model` forced null ("the pair the author ran on belongs to their box"), `setup` reset, `rebaselineSchedules(clearModel=true)` + `rotateTriggers(clearModel=true)` — schedule/trigger models cleared, tokens reminted. `data/agent.db` and `memory/` DO travel on this path (both in ARCHIVE_ROOTS).
2. **Desktop portable share/template inspector** (`apps/engine/src/desktop/templates/inspect.ts`, consumed by `apps/ui/lib/desktop/server/coworker-share/binding.ts`):
   - `ROOT_EXCLUSIONS` (`inspect.ts:23-34`): `.env`, `memory`, `data`, `mcp`, `schedules`, `triggers`, `sessions`, `runs`, `history`, `workspace/.rerun` — credentials/memory/database/routine/webhook/history/service-registry never become members.
   - Config normalized to a whitelist (`inspect.ts:140-154`): keeps only `name, kind, ephemeral, enabled, displayName, description, verbosity, setup`; forces `connectionId/provider/model: null`, `tools: {}`, `mcpServers: []`; strips `desktopToolGrants`, `desktopCodexGrants`, other tool flags, `selfImprovement` (`inspect.ts:155-185`, redaction note line 282: "Removed connection, provider, model, MCP servers, native grants, and turned every tool off").
   - `.env` reduced to key **names** as requirements (`envKeys`), never values.

## Options matrix (inert — `packages/contracts/src/desktop-duplicate-policy-options.ts`, not barrel-exported)

Four documented options; enforcement is WAITING on the user decision. Consequences:

| Option | Grants/tools | `.env` values | `mcp/` OAuth | connection/model | `mcpServers` | `data/agent.db` | memory | schedules/triggers | chats |
|---|---|---|---|---|---|---|---|---|---|
| `inherit-source` (status quo) | inherit | inherit | inherit | inherit | inherit | inherit | inherit | rotate (tokens reminted, models kept) | never inherited |
| `grants-off-credentials-inherited` | **reset** | inherit | inherit | inherit | inherit | inherit | inherit | rotate | never inherited |
| `portable-parity` | **reset** | excluded | excluded | reset | emptied | excluded | excluded | excluded | never inherited |
| `grants-off-credentials-excluded` | **reset** | excluded | excluded | inherit | inherit | inherit | inherit | rotate | never inherited |

Notes per option:

- **`inherit-source`**: matches upstream `duplicate.ts` intent verbatim ("not a regression on a copy that stays with its owner"). Conflicts with the recorded no-inherited-grants requirement (t18u/t31u) if that requirement is confirmed to cover same-box copies.
- **`grants-off-credentials-inherited`**: smallest change satisfying "Duplicate must not leave tool grants on" (DUP-G1 wording). New seam: rewrite `tools.*` grant fields in `readStagedConfig`/`makeCopy` (or a desktop-only post-write config patch). Keeps `.env`/`mcp/`/private-DB/memory/schedules copying — credential-file policy stays open per round42.
- **`portable-parity`**: Duplicate would route through inspector normalization + root exclusions. Strongest alignment with "imports create fresh identities: no inherited chats, credentials, connections, or grants" but changes Duplicate most: loses memories, private DB records, schedules/triggers, pinned model, and `.env` — likely breaks the "duplicate = working copy" expectation and duplicates inspector machinery into the engine copy path.
- **`grants-off-credentials-excluded`**: middle path — grants off AND `.env`/`mcp/` excluded (the credential files), while memory/private-DB/schedules/models still travel. Still leaves `config.mcpServers` literals and `data/agent.db` contents as open sub-questions.

Cross-cutting consequences:

- **Chats**: unaffected by every option — transcripts live in `system.db`, never copied; the copy always starts with empty history (matches "without erasing accepted independent chats" — nothing is erased, source untouched).
- **Grants**: only the `tools.*` fields in `config.json` matter; all grant checks re-read config per invocation, so a post-copy config rewrite is sufficient — no registry/enumeration change needed.
- **Credentials**: three distinct carriers — `.env` values, `mcp/` OAuth bundles, literal secrets inside `config.mcpServers.env`/`headers` (duplicate does NOT scrub these; archive does). `request_secret` values and MCP secret references live in the desktop DB and never travel regardless.
- **Enabled**: `config.enabled` and roster `enabled` inherit on every option today; portable inspector also retains `enabled`. Whether a grant-stripped copy should start disabled is part of the same user decision.
- **Idempotency**: `copy-${requestId}` + `.desktop-duplicate.json` receipt already makes retries safe; any policy change must keep receipt semantics (a completed copy is never rewritten).

## Changed paths (this lane)

- `packages/contracts/src/desktop-duplicate-policy-options.ts` — inert option enum, aspect union, documentation matrix. **Not** added to `packages/contracts/src/index.ts` (barrel is root-owned).
- `packages/contracts/src/desktop-duplicate-policy-options.test.ts` — authored unrun matrix test (option×aspect completeness, enum parse, chats-never-inherited invariant).
- `docs/desktop-next-duplicate-policy-fx09-handoff.md` — this file.

No runtime, grant, route, migration, or UI file was touched.

## Root / integration fragments

**None required for enforcement** — enforcement is gated on the user decision. Optional comment-only root note, if wanted near the duplicate route:

```ts
// apps/engine/src/http/routes/agents.ts — near POST /:id/duplicate
// FX09: duplicate grant/credential policy is an open user decision — see
// docs/desktop-next-duplicate-policy-fx09-handoff.md options matrix before changing copy semantics.
```

If the user picks an option, likely seams (not implemented): `readStagedConfig`/`makeCopy` in `apps/engine/src/agents/duplicate.ts` for grant/config stripping; `DUPLICATE_ROOTS`/`copyPlan` for file exclusions; `coworker-duplicate.ts` only if roster `enabled` semantics change. All are engine-owned; the desktop receipt/idempotency path needs no change.

## Authored unrun regressions

- `packages/contracts/src/desktop-duplicate-policy-options.test.ts` — matrix completeness (every option × every aspect exactly once), schema parse, chats-excluded invariant. **Unrun** — `packages/contracts` has no vitest config in this tree; root decides where it executes.

## Checks NOT run

All of them: tests, typecheck, lint, build, install, fixtures, formatters, provider/network, UI/browser/native, live DB, Keychain, listeners, Docker/guest, microphone, push/PR. No commit hook was triggered beyond the local commit itself; no hook-stop occurred.

## Risks / honest limits

- SOURCE citations describe code at base `8297fe64`; the desktop `duplicateAgent` has two internal paths (`copy-${requestId}` receipt path and plain `newId()` path) with identical copy semantics — both inherit.
- `data/agent.db` content inheritance is asserted from DUPLICATE_ROOTS + `copyGroup`; I did not inspect a live DB (prohibited) — the records-vs-schema distinction is inferred from `db/repos/*` using `getSystemDb` vs `getAgentDb`.
- Whether `agentConfigSchema` round-trips every `tools.*` desktop grant field on parse was not executed; behavior is inferred from the register's "inherits config grants today" plus grant checks reading `config.tools` at runtime.
- The SPEC quotes are master records of a user requirement; this packet does not claim the requirement's exact scope (same-box only vs all copies) — that scope question is part of what the user decision must settle.
- Option matrix outcomes are documentation, not enforced behavior; `seam: 'new'` marks where new code would be required.

## Status

**READY as evidence; enforcement WAITING user decision.** Local commits only; no push, no PR, no acceptance claim.
