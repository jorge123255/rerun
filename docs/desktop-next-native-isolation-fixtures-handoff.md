# Native validation isolation — design, contracts and fixtures

Source package and authored unrun regressions only. **No checks executed and no Mac acceptance claim.**

- Base: `8297fe6404caa114dcb0c2cd6006291a8abb2038`
- Implementation: `1bdaee4ebcd972076106f9f331c5002ebee96bbb`
- Original reference: `2a57fa6dd53311f763bfc9abde85997b7f7e5309`
- Supplement: `ab3def9bfcf545cc9548f99c63c2b011ca094023`
- Cloud integration left untouched: `bc-714cd9be-c9ad-5527-b2ed-6e79b2a13a08`
- Branch: `desktop/next-native-isolation-fixtures`
- Hook stop: none; `.git/hooks` contains samples only.

## Problem and launch evidence

Codex PR4 native smoke was blocked on a production-fixed profile. `HOME` alone cannot establish isolation:

- `apps/desktop/src/main/index.mjs:126-130` sets Electron `userData` to `<appData>/Rerun Desktop Preview`.
- `apps/desktop/src/main/supervisor.mjs:132-160` binds the workspace, then launches the engine with `RERUN_DATA_DIR = engineRoot` and `RERUN_HUB_BASE_URL = runtime.app.origin`.
- `apps/desktop/src/main/runtime.mjs:70-76` merely passes `HOME` through to children; it does not choose an isolated engine directory.
- `apps/desktop/src/main/workspaces/paths.mjs:27` places the engine under `workspaces/<id>/engine`.
- `apps/engine/src/config/paths.ts:5` reads `RERUN_DATA_DIR`; `apps/engine/src/config/env.ts:5-16` defaults only when that variable is absent.

No existing validation-specific launch flag was found. `--rerun-validation-profile=<absolute-path>` is therefore a **new optional integration fragment**, not evidence of an existing production flag.

## Contract

```ts
type DesktopValidationProfile = {
    version: 1
    validationId: string // UUID
    profileRoot: string // fresh directory under the real system temp root
    dataRoot: string // profileRoot/data
    engineRoot: string // dataRoot/workspaces/1/engine
    homeRoot: string // profileRoot/home
    partition: string // validation-${validationId}, never persist:*
    providers: 'empty-by-fresh-profile'
    externalNetwork: 'waiting-for-launch-enforcement'
    loopback: 'ephemeral-only'
}

type DesktopValidationIsolation = {
    profile: DesktopValidationProfile
    environment: {
        HOME: string
        RERUN_DATA_DIR: string
        RERUN_DESKTOP: 'off'
        RERUN_DESKTOP_VALIDATION: '1'
        RERUN_DESKTOP_VALIDATION_ID: string
        NEXT_TELEMETRY_DISABLED: '1'
        NODE_ENV: 'production'
    }
    manifestPath: string
}
```

The profile proves a fresh data directory and no inherited provider environment. It deliberately does **not** claim that environment variables disable outbound networking. Actual provider/socket suppression is a cloud714 launch-enforcement dependency.

## Changed paths

- `apps/desktop/src/main/validation-isolation/contract.mjs`: JSDoc contract, explicit flag parser, path/profile validation and provider-env denylist.
- `apps/desktop/src/main/validation-isolation/isolation.mjs`: fresh private profile creation, environment construction, manifest verification, isolation assertion and scoped cleanup.
- `apps/desktop/src/main/validation-isolation/index.mjs`: owned exports.
- `apps/desktop/src/main/validation-isolation/contract.test.mjs`: flag and contract regressions.
- `apps/desktop/src/main/validation-isolation/isolation.test.mjs`: real temp-directory isolation, non-reuse and cleanup regressions.
- `docs/desktop-next-native-isolation-fixtures-handoff.md`: this handoff.

No production startup, DesktopApp, contract barrel, migration, registry, packaging, checklist, Codex root, master, PR4 or other worktree was edited.

## Fixture behavior

- Creates only a fresh, empty directory under the real system temporary root.
- Requires ordinary directories and a single regular manifest file; rejects linked paths and nonempty profiles.
- Creates separate `data`, `workspaces/1/engine`, and `home` roots with private modes.
- Uses a nonpersistent Electron partition and no inherited provider credential variables.
- Writes a small manifest with the exact profile and the explicit network `waiting-for-launch-enforcement` state.
- `assertDesktopValidationIsolation` rechecks path/environment identity and provider-env absence.
- `withDesktopValidationIsolation` removes only the verified temp profile after the callback, including failures.
- No production `~/.rerun` data, account, Keychain value, provider or socket is read or changed by this package.

## Optional cloud714 startup fragment

Apply only with an explicit validation flag. The default path remains the existing production path.

```mjs
import {
    createDesktopValidationIsolation,
    desktopValidationFlagValue,
} from './validation-isolation/index.mjs'

const validationRoot = desktopValidationFlagValue(process.argv)
const validation = validationRoot
    ? await createDesktopValidationIsolation({ root: validationRoot })
    : null

const dataRoot = validation?.profile.dataRoot
    ?? resolve(app.getPath('appData'), 'Rerun Desktop Preview')
await mkdir(dataRoot, { recursive: true, mode: 0o700 })

if (validation) {
    app.setPath('userData', validation.profile.profileRoot)
    process.env.HOME = validation.profile.homeRoot
} else {
    app.setPath('userData', dataRoot)
}
```

`dataRoot` continues into the existing supervisor. Its `bindWorkspace` resolves the same `workspaces/1/engine` path as `validation.profile.engineRoot`. In `prepareWorkspaceWindow`, use the opt-in partition without changing production:

```mjs
const partition = validation?.profile.partition
    ?? (workspaceId === 1 ? profile : `persist:rerun-desktop-workspace-${workspaceId}`)
```

Do not move the fragment behind a production-default flag, do not infer it from `HOME`, and do not use an existing nonempty directory. Fresh validation state receives fresh local identity material; no production credential is read.

**WAITING:** cloud714 must separately enforce provider initialization and outbound-network suppression. The fragment alone does not prove those properties. Loopback remains ephemeral and local to the validation run.

## Authored unrun regression matrix

| Property | Authored source check | Status |
|---|---|---|
| Explicit opt-in | Missing flag returns null; absolute flag accepted; empty/relative/repeated flags refuse | READY, unrun |
| Fresh profile | Real temp creation with isolated data/engine/home roots and nonpersistent partition | READY, unrun |
| Production separation | Profile differs from `~/.rerun` and `Rerun Desktop Preview`; production and non-temp roots refuse | READY, unrun |
| Nonempty profile | Existing manifest prevents reuse as fresh state | READY, unrun |
| Provider environment | OpenAI/Anthropic/OpenRouter/Google/Brave/Codex/Claude variables are absent | READY, unrun |
| Manifest | Regular-file identity and exact profile round-trip | READY, unrun |
| Cleanup | Only the verified temp profile is removed | READY, unrun |
| Provider initialization off | Requires cloud714 startup enforcement | WAITING |
| Outbound sockets off | Requires cloud714/network enforcement; not proven by environment | WAITING |
| Packaged GUI smoke/restart | Root/cloud validation later; no app was launched here | WAITING |
| Production state untouched | Root must verify real production paths separately after integration | WAITING |

No tests, typecheck, lint, build, install, executing fixtures, formatters, provider/network activation, UI/browser/native app, live DB, Keychain, listeners, accounts, permission prompts, restart, guest/Docker, microphone, push, PR, merge, deploy or publication was performed.

## READY versus gated/WAITING

**READY as source:** additive contract, flag parser, fresh-profile fixture helpers, path/credential assertions, cleanup and typed optional startup fragment.

**GATED/WAITING:** actual startup opt-in, provider and outbound-network suppression, packaged native smoke, production-state comparison and full-restart acceptance. No property in those rows is claimed proven by this package.

Source delivery is not integration, validation, or Mac acceptance.
