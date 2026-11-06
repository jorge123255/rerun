# Desktop delivered integration handoff

Source composition only. This is not a build, not a test run, and not acceptance. Nothing here is a PASS, and the app is not ready.

## Pins

| Role | SHA |
|---|---|
| Frozen base | `8297fe6404caa114dcb0c2cd6006291a8abb2038` on `desktop/finish-cloud-base-20261106-8297fe64` |
| RD37/RD38 source compose | `969972b1c3bc6caf3e33e52af43824d3da007d55` |
| Root wiring and repairs | `a6d1a7d39a321573f159dca434b3f030bdf3e01f` |
| Integration branch | `cursor/desktop-delivered-integration-3a08` |
| Branch tip | the first child of `a6d1a7d39a321573f159dca434b3f030bdf3e01f` (this handoff and the draft test plan). Confirm with `git rev-parse HEAD` on the pull request head. |
| Outer source archive | SHA256 `1af5e7b3a9811511c4daf91df3a1e0c5fb47f53369190876403f3eefdd30e51d` (1,213,583 bytes) |
| Nested gap archive | SHA256 `e4a7110d9b8b68a9937ffb1c76ce47d7fb7d80482e3d89eb4c42b771b142f7e3` (97 files) |
| F contract blob | `254be83e555e0653973a885724968b52e55b5364` (`packages/contracts/src/desktop-api-connections.ts`) |
| Codex root (untouched, not an ancestor of this branch) | `208038f5a24606c8834e7bdc1f352e81fa615c8e` |
| Root/master merge-base (not folded in) | `6f6ad959a09abaf1947950b6f82413c94407e22a` |
| Original design pin (read, not rebased) | `2a57fa6dd53311f763bfc9abde85997b7f7e5309` |
| Supplement pin (not present in this clone; not rebased) | `ab3def9bfcf545cc9548f99c63c2b011ca094023` |
| Signer preserved | `21C5B4D06CE5EDF47143C1327B72D76E478A065D` |

No merge, deploy, or release. PR1, PR2, and PR3 were not merged. Their branches were not rewritten.

## Input manifest

Master nine were already on `8297fe64` and were not reapplied: `cb7a184d918e45899574c37232c43dba1261bd44`, `1e1b6ea138ff3e0c3051e2607304d0ea33260ec0`, `73b6855e6d227011fcd6198ce3ee71f1d640a94c`, `d7dc1685e2b2648c7a61c29ade8fa8a7b95992d0`, `2520a0ef3d483bd29c66e12fdb4ebfd37761a4bb`, `d0b2a79834261ad34e04abd4e9ce20e1f79cdc16`, `4415d3193bc467d0f25cbd9fdfdb3d76bf5c65f8`, `42aa785f9b72ca676bc473cab0f708f899db0d3f`, `aed685747b0ee88fad99e90bf870650be997d990`.

RD37 tips, base `e87edabffded9b56c67f98539a412e230959435c`, applied as patches:

| Pkg | Tip | Class |
|---|---|---|
| A custom provider runtime | `9f6893da8c4d2180787833fd20989304a939c7c1` | source composed |
| B custom provider UI | `f816616020cf4ce68d7001fa2247de28c3f7c8ab` | source composed; Settings mount not added |
| C OpenCode runtime | `440d9b283aae1ed362eca3daab4aa05493ceaaef` | source composed; route not mounted |
| D OpenCode UI | `dbecf4b398d844e158d9eeb3281d45e30d7b75d1` | source composed; Settings mount not added |
| E company profile runtime | `5d16ee6d625896735d7210715da786544d85a4e1` | source composed; schema step 34; HTTP route not mounted |
| F company profile UI | `4342cde078f6ac01c633e5d4c368b0b307d14c69` | source composed; Foreman mount not added |
| G chat interactions | `66ea16bf66d3202558f16a44833c8077f0d7cf21` | source composed; question/voice mounts not swapped |
| H chat recovery notice | `f0e1425743e86811109592ecca17c5031b5ed82d` | source composed and notice mounted beside PR2 |
| I runtime compatibility | `32963bb5867df40a4c098126b1d47c3e0d9bb7fb` | source composed; Codex error fragment not applied to the shipped runner |

RD38 tips, base `6f6ad959a09abaf1947950b6f82413c94407e22a`:

| Pkg | Tip | Class |
|---|---|---|
| C control center | `80cdcab42e3aada421e546cfa4b85f9d1cb5d6a2` | source composed; duplicate prop repaired; launch nonce forwarded |
| D historical presenters | `7e1069903ad7a5926e41df159bc1fd4f0bba56b5` | source composed; mounted before `DesktopToolStep` |
| E share UI | `7ceabd5400ab160b6aa809853f98dbb28f9a37d5` | source composed; memories/database stay unavailable |
| F connection store | `72e8ef863fa353897115f46d363b7020e0282f63` | source composed; fingerprint repaired; engine route mounted |
| G settings UI | `efdf4f0bd63a175fcb5e234e133d97d209f10d35` | source composed; panel mounted; select stays disabled |
| H readiness | `62c7a5d81eabeed472c8ea90b277fd2ce1e24da0` | source composed; not signed or packaged |
| I remote gateway | `a9fa38881e30e31d5fa20e516bb7bbff562765b6` | source composed; not mounted; no listener |

Cloud PRs, each parent is `8297fe64`. Remote tips were verified before cherry-pick. Cherry-picks on this branch are new commits; the author commits were not rewritten.

| PR | Remote tip | Remote implementation | Cherry-pick on this branch |
|---|---|---|---|
| PR1 WhatsApp | `976d7a55c8899e59f1acd70c9300abb7526db0e5` | `e7e2286e2f43d4bfed69e2925f28b0aaed2341b5` | `bc71a36cf7ace1ee1d93445d6e0df1a5c13fca33` / `d313ea97a7683e7faab90035572d19d1ac64ca56` |
| PR2 workflows | `d487a2df986feb6d969246abacc6b1f3dfb065d7` | `d3b35f4f7a7fbebbb0f89b790bbfd52a31962b30` | `8a24c41345c4d7f4838cc4fa6a40ab68197e0ce6` / `37b78319756e5ee7ba1c9b559fec9225bb64fbfc` |
| PR3 Foreman files | `b8db7f861513e21d1f7c3059bdb635ab1e29821f` | `78d8c7b80c822eb3a3372100633b886d3970a841` | `db6f7802cc21db7b44305d3b6e95458dbb41d0bb` / `aeda0837602f0a5aaed739812e5c5b8b38367964` |

Package diffs did not overlap each other or the `8297fe64` delta. PR diffs did not overlap each other or the package diffs. Cherry-picks applied without conflict.

## Migration numbers

| Ladder | Version | Id | Where it runs |
|---|---|---|---|
| Engine data-dir | 8 | `desktop-api-connections` | `initializeDesktopApiConnections()` on the engine database. Next free after version 7. |
| Desktop UI sqlite | 34 | `company-profile-derived-attempts` | `initializeDesktopRound37` after round 36 (version 33). |

No shipped step was renumbered. API-connection receipt tables are not copied onto the desktop UI database. The canonical connection files and the G proxy live on the engine. Company-profile attempt tables are on the desktop UI database because that package’s store is there. The company-profile HTTP route is not mounted: `desktopCompanyProfile` still needs the existing Foreman app object, and a second app was not invented.

## Production bindings

```
Settings AI providers
  -> ApiConnectionsPanel (selectionContext null, so default select stays disabled)
  -> /api/desktop/api-connections/:workspaceId/...
  -> engine /desktop/api-connections
  -> createDesktopApiConnectionRuntime
       pendingRuns = pendingDesktopApiConnectionRuns
       stopAndDrain = stopAndDrainDesktopApiConnectionRuns
       custodyKey = RERUN_DESKTOP_SECRET_KEY (HMAC; missing key refuses secret writes before reserve)
  -> canonical connection store, filtered to cnx_ ids

chat stream start
  -> admitDesktopApiConnectionRun when the override connection id is cnx_
  -> listRunsByAgent(status running) + connectionUsage for removal
  -> abortRun + waitForRunCancellation during drain

DesktopConversation
  -> PR2 resume, persisted lastError, MarkdownEditorDialog, find-in-page
  -> useDesktopChatRecovery / DesktopProviderErrorNotice
  -> history load errors stay on their own retry
  -> one banner: the notice when it classifies, otherwise the PR2 stop banner

DesktopAssistantReply
  -> selectDesktopHistoricalCard before DesktopToolStep
  -> notify_user failed/unknown rows are not rendered
  -> brain_propose / skill_propose / file and table cards unchanged

DesktopApp
  -> settings bootstrap runtimeLaunchNonce
  -> DesktopControlCenter forwards it into the parity context key

external MCP catalog
  -> create_agent / update_agent projection drops tools and selfImprovement
  -> assertExternalMcpCatalogOmitsAuthorityFields runs before those writes

Foreman file tools
  -> desktopRerunGrantIds gains foremanAgentFilesRead and foremanAgentFilesWrite
  -> catalog rows spread from desktop-foreman-agent-files
  -> missing grant stays false
  -> registry.ts unchanged; Brain write/delete/proposals/decide unchanged
```

Existing Codex/Claude settings, the legacy API-key form, and `setBoxDefault` from Settings remain. Named `cnx_` connections are an additional panel. Select through F is refused by the UI handler because no `authorizeSelection` callback is installed. That is a disabled control, not a successful select.

## Repairs on this branch

- F receipt fingerprint no longer stores SHA-256 of the raw secret. A 32-byte desktop custody key HMACs a domain-separated secret term into the request fingerprint. Different secrets still differ. Omitting the secret is not the fingerprint. No new secret log line was added. If the key is absent, the secret-bearing mutation returns refused and is not reserved.
- Control Center test no longer passes `runtimeWorkspaceId` twice. The Servers case keeps workspace 2.
- `runtimeLaunchNonce` from `readDesktopWorkspace` is forwarded into `useDesktopControlParity`. Original pre-search labels were already applied by `originalControlLabels`.
- Historical cards mount before the generic tool row. RD37 question cards are not replaced by D. UP02 team presenters are not part of D.
- Share safety copy states a credential exclusion only when the archive’s own exclusion list contains reason `credentials`. File counts stay the plan’s file bucket. Memories and database unavailable strings are still set. `sectionBindings` are not passed, because capture, validation, and install are not all bound. Clearing those strings without that binding was not done.
- W4 catalog projection stops advertising `tools` and `selfImprovement` (and the other authority field names) on create/update. The assert runs before the external write. The earlier operation refusal remains.
- Document attach in the composer awaits `documents.add` and reports each rejected file.
- Native `bridge.notify` remains. A `notify_user` part whose projected status is failed or unknown is not shown.
- Duplicate grant and credential inheritance on clone is unchanged. There is no new global forbid. The t31u source/spec discrepancy stays open.

## Authored sources, not executed

Every `*.test.ts`, `*.test.tsx`, and `*.test.mjs` that arrived with RD37, RD38, and PR1–3 is an authored regression source. None of those files were executed in this integration. No typecheck, lint, build, install, or desktop package was run. `@rerun/contracts` `dist/` was not rebuilt, so new barrel exports are source-only until a later build.

## Ten pending deliveries (not in this composition)

These were separately assigned after this integration started. They are not delivered here. No files from those lanes were copied. Status was not re-checked against their working trees.

| Delivery | Owner | State in this branch |
|---|---|---|
| UP01 scheduler | local finish branch, unstarted at `8297fe64` as of the supplied manifest | not implemented |
| UP02 team reads | local finish branch | not implemented |
| UP04 public binary download | local finish branch | not implemented |
| UP05 vision | local finish branch | not implemented |
| UP06 table view model | local finish branch | not implemented |
| UP07 notify_user native receipts | local finish branch | not implemented (only the historical failed/unknown hide above) |
| FX overflow, board camera, skeletons | local finish branch | not implemented |
| UI01 coworker overview | cloud `bc-2683255f-ef74-5c86-a76f-3d9c7325dbba`, `coworker-overview/**` | not implemented |
| UI13 subscription profiles | cloud `bc-34536bee-094a-5451-adb6-88b07f29c094`, `subscription-profiles/**` | not implemented |
| Remote/public share/webhook security foundation | cloud `bc-1e95582a-a658-55d3-8480-85f654b18cc8`, `optional-connectivity/**` | not implemented; not a fork of RD38 I |

## Future activation (not authorized)

| Item | State |
|---|---|
| RD38 I remote host, listeners, physical ports | source present, startup does not import it |
| RD43 remote activation | not implemented |
| RD44 public hosting, webhooks, accounts, ACL | not implemented |
| RD45 phone pairing, mobile, distribution | not implemented |
| WhatsApp Status posting | source present, setup component not mounted, no account dispatch |
| Signing, notarization, entitlements, update feeds | not run; signer string unchanged |
| Company profile Foreman route and UI | schema only |
| Custom provider, OpenCode, chat-interaction v2 mounts | modules present, central mounts not swapped |
| Share memories and coworker database | unavailable until capture, validation, install, preview, and digest are all bound |
| API-connection select from the new panel | disabled; Settings default path remains |
| Legacy non-`cnx_` API keys inside the F catalog | filtered out so the `cnx_` schema does not throw; edited by the existing Settings form |

## Counts

| | |
|---|---|
| Delivered packages composed into this branch | 16 RD37/RD38 + 3 cloud PRs |
| Master-nine packets reapplied | 0 |
| Root repair commit | 1 (`a6d1a7d39a321573f159dca434b3f030bdf3e01f`) |
| Pending deliveries excluded | 10 |
| Checks executed | 0 |
