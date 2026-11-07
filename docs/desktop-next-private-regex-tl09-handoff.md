# TL09 — private-file regex search semantics

Worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-private-regex-tl09`, branch `desktop/next-private-regex-tl09`, base `8297fe6404caa114dcb0c2cd6006291a8abb2038` (frozen pub `desktop/finish-cloud-base-20261106-8297fe64`).

Implementation commit `c38d111c1193e3c947183ee53086c17a89d9cad6` (`Port private regex search semantics`). The implementation worktree was clean apart from this uncommitted handoff, committed separately.

Source handoff only. No tests, typecheck, lint, builds, installs, fixtures, provider/network activation, browser/native UI, live DB operations, Keychain, listeners, account actions, permission prompts, restart, guest/Docker or microphone were run. This is not Mac acceptance.

## Original evidence and mapping

- `2a57fa6dd53311f763bfc9abde85997b7f7e5309`, `apps/engine/src/tools/builtin/fsTools.ts`: original `fs_search` uses a JavaScript `RegExp`, returns `path:line: content`, skips `node_modules` and `.git`, defaults to 200 results capped at 1,000, trims each matching line to 300 characters, and returns `No matches.` or `(truncated at N results)`.
- Same pin, `apps/engine/src/files/store.ts`: regex is constructed without flags, so matching is case-sensitive. Each line is tested independently and matching lines retain original text up to 300 characters.
- `ab3def9bfcf545cc9548f99c63c2b011ca094023`, `apps/engine/src/tools/builtin/filesystem.test.ts`: real resize and stopped-run evidence is reference only.
- Current `apps/engine/src/desktop/workspace-read.ts`: private literal case-insensitive search and existing 32 KiB/visible-path/grant confinement.
- Current `apps/engine/src/desktop/shared-file-mutations/regex.ts`: shared off-thread, bounded regex execution and Stop behavior. It is reused without editing shared search.

The new adapter changes only private `fs_search` semantics: JavaScript `RegExp` without flags, original result shape and truncation text. No new tool ID, migration, shared search edit, DesktopApp, DesktopConversation, composer, contract barrel, grant enum, central registry or packaging change was made.

## Owned implementation

- `files.ts`: `desktopPrivateSearchPathAllowed` and `desktopPrivateRegexSearch`. Bounded directory walking, safe descriptor revalidation, 32 KiB UTF-8 reads, original regex results and native error containment.
- `tools.ts`: `desktopPrivateRegexTools`, original `fs_search` description, path/pattern/maxResults inputs.
- `search.test.ts`: case-sensitive matching, metacharacters, invalid patterns, missing paths, hidden assets, reserved/dependency exclusion, result/line limits, revoked grant and pathological cancellation.

## Behavior and limits

- JavaScript `RegExp` without flags: case-sensitive matching, including character classes, anchors and other normal JS metacharacters. Invalid patterns return `Invalid regular expression: …`.
- Results use `relative/path:line: matching text`, capped at 300 characters per line and 200 matches by default, with a hard maximum of 1,000. Reaching the cap appends `(truncated at N results)`.
- `No matches.` is returned when nothing matches. Missing directories return `Path not found: <path>`.
- Directory traversal is bounded to 32 directories, 128 files and 512 entries per directory. Text reads retain the current 32 KiB limit, fatal UTF-8 validation, single-inode/no-link checks and grant rechecks.
- Ordinary hidden user assets such as `.hidden/ordinary.md` are searchable. Every path segment beginning with `.rerun` is excluded at every depth, including `.rerun` and `.rerun-skill` aliases. `node_modules` and `.git` are also skipped.
- Native directory failures return a safe unavailable error, not an absolute host path. No other coworker workspace, link, arbitrary URL or content exfiltration path is introduced.
- `sharedRegexLines` preserves off-thread pathological-pattern limits and cancellation. Stop never returns a successful partial analysis or auto-retries the effect.

## Root integration fragment

No new tool ID is needed. Use the owned factory as a drop-in semantic upgrade for the existing private `fs_search` registration:

```ts
import { desktopPrivateRegexTools } from './desktop/private-search/tools.js'

{
    family: 'filesystem',
    build: ctx => desktopPrivateRegexTools(ctx),
    enabled: config => config.tools.workspaceSearch,
}
```

Keep the existing `workspaceSearch` grant and live config checks. Tool invocation happens only when the model calls `fs_search`; mounting, history reads and previews perform no search.

## READY vs gated / WAITING

- **READY in this source package:** original case-sensitive JS regex semantics, bounded private reader/walker, hidden/reserved path policy, grant checks, original result/truncation shape and unrun regressions.
- **Root-gated:** registry mount, current grant registry presentation, native traversal and full-restart acceptance.
- **WAITING for no source decision:** shared search remains untouched; no duplicate-grant or credential-inheritance policy is inferred or enforced. Codex listing suspicions remain unconfirmed and unchanged.

## Authored unrun regressions

- Case-sensitive matching and JavaScript metacharacters.
- Invalid regex and missing directory responses.
- Ordinary hidden assets accepted; `.rerun`, `.rerun-skill`, `node_modules` and `.git` excluded.
- Result truncation and 300-character line limits.
- Revoked grant without content access.
- Pathological pattern cancellation without a fake successful result.

No checks were executed and no result was fabricated. Root owns all checks, repairs, packaging and Mac acceptance.

## Commit-hook status

The common Git hooks directory contains only `.sample` files, so no executable hook ran during the commits. No hook blockage occurred and `--no-verify` was not used.

## Risks and remaining limits

- The new hidden-asset behavior intentionally follows the assignment’s requirement to preserve ordinary hidden assets while excluding reserved aliases; it does not relax those reserved paths or shared search behavior.
- Current 32 KiB private-read bounds are preserved rather than the original hosted 100,000-character read limit.
- Root still must mount the adapter and validate real workspace traversal, grant revocation, cancellation and restart behavior.
