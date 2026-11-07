# Rerun Desktop Preview for macOS

This is Rerun Desktop Preview, the macOS app being developed on
[our fork](https://github.com/jorge123255/rerun/tree/desktop/macos-preview).
The `desktop/macos-preview` branch is the checkpoint for reviewed integration
work. The [Mac development status](../../docs/desktop-macos-status.md) records
what is present, what was tested, and what still needs Mac acceptance.

The app is under development. This branch is not an upstream submission or an
installable release, and publishing it does not update an installed preview.

## One product, shared code and design

| Location | Responsibility |
| --- | --- |
| `apps/desktop/src/main` | Electron lifecycle, trusted native bridges and local service supervision |
| `apps/ui/components/desktop` | Board, coworker side-panel chat, tabs and desktop settings |
| `apps/engine` | Coworker execution, model providers, tools and memory |
| `packages/ui` and `packages/contracts` | Original design components and shared schemas |
| `scripts/desktop` | Runtime staging, native helpers, packaging and verification |

Keep shared UI and engine behavior in those existing packages. The desktop shell
provides the Mac integration. Product changes continue to follow Rerun's original
code and design.

## Development checks

Use a separate worktree for development and a fresh dependency store for isolated
QA. The repository records `pnpm@8.15.4`. The bundled runtime targets Node 22 and
`darwin-arm64`; Intel Mac and universal builds are not established here.

From the repository root, the source checks are:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @rerun/contracts build
pnpm typecheck
pnpm --filter @rerun/desktop test
```

Engine and UI tests run from their respective package directories using
`pnpm exec vitest run`; UI lint uses `pnpm exec eslint .` in `apps/ui`.
Isolated validation must omit real provider/account configuration and use only
temporary stores and fixture services. Source checks do not establish packaged
Mac, Keychain, provider or restart acceptance.

## Mac packaging and acceptance

The existing root packaging entry point is `pnpm desktop:package`, configured by
[`electron-builder.yml`](electron-builder.yml). It stages the shared UI, engine,
Node runtime and native helpers for Apple-silicon macOS. Packaging requires the
Mac build tools and a stable preview signing identity; the signing helper checks
the existing identity so repeated updates can retain Keychain continuity.

The current app entry point still selects the normal `Rerun Desktop Preview`
profile. The November 6 update used a private backup, the existing isolated QA
workspace and its own authorized Codex login; it did not create a second visible
app or treat `--user-data-dir` as a temporary-profile seam. Its production build,
stable signature, board/chat/import and full-restart checks passed on
`0bddbc5cd689a8d62bfbe6d6d3a82f42281f2c62`. The
[native QA report](../../docs/desktop-native-qa-2026-11-06.md) records the exact
scope and original-workspace preservation results.

A documented temporary-profile startup with side effects disabled before launch
remains future work for fully automated isolated QA. This local preview update
is not a downloadable or notarized release.

Before a downloadable build is marked ready, the integration owner must verify the actual app:

- Open a coworker from the board and send a Codex message in its side panel.
- Close the panel and return to the same board position.
- Restart, reopen the same chat, and verify replies, drafts, model/reasoning
  choices, coworker settings and permissions persist for the correct owner.
- Check shutdown, stable signing and account access without replacing real data
  with test fixtures.

See the [current status and next work](../../docs/desktop-macos-status.md), the
[delivered-integration manifest](../../docs/desktop-delivered-integration-handoff.md)
and the [historical delivery ledger](../../docs/desktop-progress.md).
