# Subscription profile adapter

Source only. Not validated. No tests, typecheck, lint, build, or app run were executed. This is not a PASS and not proof that a second ChatGPT or Claude account can run.

## Base and tip

- Base: `8297fe6404caa114dcb0c2cd6006291a8abb2038` on `desktop/finish-cloud-base-20261106-8297fe64`.
- Branch: `cursor/subscription-profiles-c094`, created from that commit. Foreman PR #3 (`cursor/foreman-agent-files-c094`, tip `b8db7f861513e21d1f7c3059bdb635ab1e29821f`) was not changed.
- Implementation commit: `2cc4fb9e8eee302170a399fa5e52c585af722ab7`.
- The branch tip is the commit that records this line. Its SHA is copied into the pull request from `git rev-parse HEAD`.

## Custody and provider evidence

RD38 F tip `72e8ef863fa353897115f46d363b7020e0282f63` and G tip `efdf4f0bd63a175fcb5e234e133d97d209f10d35` were read as frozen patches. Their shared contract blob is `254be83e555e0653973a885724968b52e55b5364` (`packages/contracts/src/desktop-api-connections.ts` in that patch). That contract enumerates only `anthropic`, `openai`, `google`, and `openrouter`. It was not edited and it is not imported. F’s handoff excludes Codex, Claude, custom, and OpenCode changes.

This module depends on the same custody shape F uses for removal: `pendingRuns(connectionId)` must return the real run list, and `stopAndDrain(connectionId)` must stop those runs. A missing drain refuses removal. An unknown stop is stored as `uncertain` and the same request is not sent again. There is no second token store and no credential hash.

RD37 custom-provider packages are API-key connections. They are not a ChatGPT or Claude subscription session. ChatGPT Plus or Pro is not treated as an API key.

Current desktop adapters, read on this base:

- ChatGPT: `apps/engine/src/desktop/codex-runtime.ts` fixes `mac-chatgpt` and one `dataDir()/chatgpt` directory. `desktop/policy.ts` allows `codex` only for that id.
- Claude: `packages/contracts/src/desktop-claude-plan.ts` fixes `mac-claude`. `desktopClaudeRuntime` rejects every other id. A spawn directory under `dataDir()/claude/<uuid>` is an ephemeral sandbox for that one token, not another account.

Neither adapter has an independent second session. This source does not discover installed CLI profiles and does not copy browser, CLI, or Keychain credentials.

## Supported and not supported

| Provider | What this source can do | What remains blocked |
|---|---|---|
| ChatGPT (`codex`, `mac-chatgpt`) | Show the one current session, save an extra display name as unavailable, select only that same session, bind a run to a credential generation | A second authenticated session, login, and execution of any other profile |
| Claude (`claude`, `mac-claude`) | Same, for the one `mac-claude` token | A second token or account, login, and treating a sandbox directory as an account |

`providerReady` is always false in the profile view. `credentialMetadataPresent` may be true when the custody port says a flag or key exists. That is not authentication and not permission to call the provider.

The preexisting singleton path in the Codex and Claude runtimes is not wrapped. Until a person explicitly selects a compatible profile, this module does not change that path. The only compatible explicit selection is the current builtin session. Selecting any other profile is refused and the previous selection stays.

## Profile schema

Durable rows are display name, provider, optional canonical connection id, optional credential generation (`rev_…`, `gen_…`, or a decimal revision), availability, and an explicit-selection flag. Run bindings add workspace, owner, agent, profile, connection, generation, run, and session. Receipts store the public request JSON. There is no secret, token, cookie, or hash column. See `SUBSCRIPTION_PROFILE_DDL` in `apps/engine/src/desktop/subscription-profiles/store.ts`.

The table is not created here. `subscriptionProfileMigrationFragment` is a typed DDL fragment with slot `NEXT_DESKTOP_SQLITE_MIGRATION` for root to apply in the next desktop SQLite transaction.

## Execution binding, replacement, and drain

`capture` writes one snapshot for a builtin profile only when custody returns a generation. A missing generation refuses. The same run id is not rewritten to another profile, owner, agent, session, or generation.

`admit` re-reads custody and the stored generation. A mismatch throws and leaves the snapshot unchanged. It does not return a credential.

`recordGeneration` updates the profile row’s generation and does not update existing run rows.

`remove` of the builtin session calls `pendingRuns`. A non-empty list refuses before `stopAndDrain`. A missing `stopAndDrain` refuses. One `unknown` or thrown stop becomes `uncertain` and that request id does not call stop again. A saved removal clears only the explicit-selection flag. It does not delete the connection credential.

`remove` of an unavailable named profile deletes that row only. It never copies the builtin generation onto it.

## Root fragments

- `apps/engine/src/desktop/subscription-profiles/root-fragment.ts` — DDL slot and custody method names.
- `apps/ui/components/desktop/subscription-profiles/mount-fragment.ts` — selector mount. `DesktopSettings.tsx`, `DesktopApp.tsx`, and `DesktopConversation.tsx` were not edited.
- `packages/contracts/src/desktop-subscription-profiles.ts` is not exported from `packages/contracts/src/index.ts`. Engine and UI use runtime copies until root adds one export and rebuilds contracts.

Not edited: connection store, provider dispatch, migrations, barrels, catalogs, grant enums, settings routes, and the F/G author files.

## Authored tests, not run

`apps/engine/src/desktop/subscription-profiles/subscription-profiles.test.ts`

- DDL text has no secret, token, hash, or fingerprint column
- metadata present still has `providerReady: false`; a named profile has no connection id or generation; selecting it is refused and does not become the selection
- another workspace is refused
- a captured run is not retargeted after a new generation or a different profile on the same run id
- pending runs block removal before drain; missing drain refuses; an unknown stop is not called again for the same request
- capture without a generation refuses and returns no snapshot

`apps/ui/components/desktop/subscription-profiles/subscription-profiles.test.ts`

- the current session stays selectable and says metadata is not signed-in; the other profile is unavailable
- both capability lines state the one-session limit
- an uncertain attempt is not sent twice

## Checks not run

Not run: tests, typecheck, lint, build, install, formatters, UI, native, browser, database, Keychain, provider probes, account login, network, listeners, permissions, restart, signing, certificates, entitlements, and update feeds. No merge, deploy, or release.

## Still blocked

Second-account execution for both providers. Login, OAuth, CLI profile import, and Keychain access. Wiring `pendingRuns` and `stopAndDrain` to the real run authority. Applying the DDL. Exporting the contract. Mounting the selector. None of those are done by this branch.
