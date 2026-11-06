# UP-05 / TL02 — own-file vision via selected connection/model

Worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/finish-vision-up05`, branch `desktop/finish-vision-up05`, base `8297fe6404caa114dcb0c2cd6006291a8abb2038` (frozen pub `desktop/finish-cloud-base-20261106-8297fe64`).

Implementation commit `1b6c4afc0a0f4d20df599caf52aed54aef07f9bc` (`Add selected-model own-file vision tools`). The implementation worktree was clean apart from this uncommitted handoff, committed separately.

Source handoff only. No tests, typecheck, lint, builds, installs, fixtures, provider/network activation, browser/native UI, live DB operations, Keychain, listeners, account actions, permissions prompts, restart, guest/Docker or microphone were run. This is not Mac acceptance.

## Dependencies and original evidence

- Original design pin `2a57fa6dd53311f763bfc9abde85997b7f7e5309`: `apps/engine/src/tools/builtin/vision.ts` and `apps/engine/src/tools/catalog.ts`.
- Supplement pin `ab3def9bfcf545cc9548f99c63c2b011ca094023`: `apps/engine/src/tools/builtin/vision.ts` and `vision.test.ts`.
- `apps/engine/src/agents/providers.ts`: selected `modelFor` and `ModelOverride`, native CLI reading, per-call model lifecycle.
- `apps/engine/src/connections/cli-auth.ts`: selected-connection auth release.
- `apps/engine/src/tools/sandbox.ts`: workspace path resolution.
- `apps/engine/src/agents/types.ts` and `desktop/tool-grants.ts`: current agent config and live grant checks.

The original tool uses the current model unless an OpenCode model cannot see, then chooses another seeing model of that same connection. It uses native CLI file reading where appropriate, inline images elsewhere, 2048px resize, 4 MiB target size, and Stop/timeout handling. The supplement adds real resize and stopped-run regressions.

Existing image attachment and computer screenshot interpretation are separate workflows. The desktop registry currently omits this standalone `vision_analyze` family, so this package is additive rather than a replacement.

## Owned implementation

- `files.ts`: `desktopVisionPathAllowed`, `resolveDesktopVisionImage`, `desktopVisionImageMessages`. Workspace-only image paths, real format/metadata validation, symlink refusal, 16 MiB input cap, original 2048px/4 MiB downscale path and native CLI prompts.
- `model.ts`: `desktopVisionModelFor`, `canonicalDesktopVisionModelPort`, original `NO_VISION_MODEL`. Selected provider/model is preserved; OpenCode falls back only to the cheapest seeing Go model in the same connection. Missing metadata or no seeing model returns `null`, never a fake provider/OCR result.
- `tools.ts`: `desktopVisionTools` and `DesktopVisionPorts`. Active-run and `tools.vision` + `tools.filesystem` checks before file/model work, second grant check before generation, selected model/auth adapter, original error/timeout/Stop behavior and auth release.
- `files.test.ts`: reserved aliases at every depth, ordinary hidden assets, real large/small images and broken input.
- `model.test.ts`: current seeing model, same-connection Go fallback, missing seeing model and missing metadata.
- `tools.test.ts`: owned image generation path, unavailable model, disabled grant, missing active run and stopped generation.

No contract barrel, global registry, migration, provider enum, DesktopApp, DesktopConversation, central model catalog or packaging file was edited.

## Exact root activation fragments

### Registry

Mount the owned factory for the existing `vision` family instead of the omitted desktop adapter:

```ts
import { desktopVisionTools } from './desktop/vision-tools/tools.js'

{
    family: 'vision',
    description: 'Analyze workspace images with the coworker multimodal model.',
    build: ctx => desktopVisionTools(ctx),
    enabled: config => config.tools.vision,
}
```

Keep the original `vision_analyze` name and description. Tool execution, not registration or history rendering, starts model work.

### Grant and identity

The owned factory already enforces `current.enabled`, `current.tools.vision`, `current.tools.filesystem`, and `ctx.runId`. Root should expose the existing `vision` grant in Tools settings and preserve its default policy; no new grant enum is required.

Recheck the current config on every call. Do not substitute `privateFileWrite` for the read grant, and do not let a preview, historical message, or mount invoke the model.

### Selected connection/model

`desktopVisionModelFor` consumes `ctx.agent.resolved` only. For OpenCode, supply the current connection’s `providerModels` metadata when available. A selected seeing model is used unchanged. Otherwise the adapter returns only `{ model: <seeing Go id from that connection> }`, or `null` when no Go model sees or metadata is absent.

The production port then calls:

```ts
modelFor(agent, selectedOverride, undefined, undefined, {
    claudeTools: ['Read'],
    sessionId: ctx.sessionId,
})
```

This preserves the selected connection and native Codex/Claude reading. `ensureCliAuth` releases the selected connection’s auth in `finally`. There is no silent provider, credential, model, workspace or connection fallback.

Root must keep provider catalog/model resolution and run-local credential custody. Do not move decrypted credentials into this package’s views, logs, receipts, history or portable files.

### Lifecycle

`desktopVisionImageMessages` uses the original native CLI prompt where `CLI_PROVIDERS` matches, and bounded inline image data elsewhere. `deadlineSignal` preserves the original ten-minute outer bound; Stop aborts the actual generate call. Uncertain or stopped outcomes are not retried automatically.

## Behavior and limits

- Accepted types: PNG, JPEG, GIF and WebP by extension and `sharp` metadata.
- Input cap: 16 MiB per image. Larger inputs fail before model work.
- Downscale: maximum edge 2048px, WebP quality 85; the converted target remains bounded by the original 4 MiB behavior where possible.
- Every segment starting with `.rerun` is refused at every depth, including `.rerun`, `.rerun-skill`, and other reserved aliases. Ordinary hidden assets such as `.hidden/photo.png` remain allowed.
- Absolute paths, backslashes, traversal, symlinks, unsupported types, oversized files and broken images are refused. No arbitrary URL or other coworker workspace can be read.
- Empty model text returns the original `(the model returned no text)`. Unsupported-model, read, timeout and Stop outcomes retain original wording and never claim success.

## Already implemented / new / gated

- **Already present:** image attachments, screenshot interpretation, selected model/provider infrastructure, canonical connection custody and native CLI reading.
- **New additive source:** standalone `vision_analyze`, own-file path confinement, selected-model fallback, grant/active-run enforcement, bounded real-image adapter and regressions.
- **Root-gated:** registry mount, current providerModels metadata where required, selected model/credential execution, native acceptance and full-restart QA.
- **Unsupported here:** provider activation, live accounts, fake OCR, arbitrary URL fetches, other-workspace reads, silent provider/model fallback, secret export, public exposure and installed acceptance.

## Authored unrun regressions

| Area | Source | Behavior covered |
| --- | --- | --- |
| File identity | `files.test.ts` | Reserved aliases at every depth, ordinary hidden files, real 2048px downscale, small-image preservation, broken input |
| Selected model | `model.test.ts` | Current seeing model, same-connection cheapest Go fallback, no seeing model, no metadata |
| Tool lifecycle | `tools.test.ts` | Selected-model generation, auth release, no-model refusal, grant refusal, active-run refusal, stopped generation |

No regression was executed and no provider result was fabricated. Root owns all checks, repairs, packaging and Mac acceptance.

## Commit-hook status

The common Git hooks directory contained only `.sample` files, so no executable hook ran during either commit. No hook blockage occurred and `--no-verify` was not used.

## Risks and remaining limits

- OpenCode metadata is required to prove model vision support. Its absence returns the honest unsupported message rather than assuming a model can see.
- Native CLI and inline model transports are real adapters only when root binds the selected model. This package itself performs no account/provider action.
- The 16 MiB input cap is a Mac safety addition; original 2048px/4 MiB conversion behavior is retained.
- Duplicate grants and credential inheritance policy remain a root/user decision and are unchanged.
- Cloud integration, central registries, migration and packaging identity remain unmodified and outside this handoff.
