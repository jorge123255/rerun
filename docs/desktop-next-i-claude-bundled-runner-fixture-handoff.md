# I — Bundled Claude runner boundary fixture

Branch: `desktop/next-i-claude-bundled-runner-fixture`
Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-i-claude-bundled-runner-fixture`
Base/parent: `d518abdbfd38985ab4c185950c22e36b1b90a269`
Base tree: `94f7b0220733175e86c022befcd592752303be82`
Exact clean base verified before editing. Final tip/tree supplied with delivery.

## Original and mounted comparison
Reference: original Rerun dev `c33c020ffb33263ec29de6f76d9b269bca786d90`.
- `apps/ui/components/connections/use-claude-oauth.ts`: original web Claude connection hook. Arms a PKCE flow, opens claude.ai's authorization page, and submits the code (or a hand-pasted `claude setup-token` token) against an exchange action; phase machine `idle | waiting | checking | connected`, re-open lock, error handling.
- `apps/ui/lib/engine/claude-oauth.ts`: server-side PKCE constants, `buildClaudeAuthorize` (verifier/challenge/state) and the exchange transport against Anthropic's subscription token endpoint; mints the long-lived `CLAUDE_CODE_OAUTH_TOKEN`.
- `apps/ui/components/connections/plan-connect/ClaudePlanSteps.tsx`: the plan-connect approval UI (Open Claude -> paste code -> connected).

Mac desktop path: `DesktopClaudePlanSteps.tsx`/`DesktopClaudeLogin.tsx` -> `claude-plan-client` runtime -> `/api/desktop/claude-login` -> engine `/desktop/claude-login` -> `apps/engine/src/desktop/claude-plan/auth.ts`. The desktop side reuses the same OAuth client/exchange semantics but gates them behind the singleton `createDesktopClaudePlanAuth` with attempt/revision custody and, crucially, a **model-execution seam the web flow never had**: the signed-in credential is handed to `apps/engine/src/desktop/claude-plan/runtime.ts`, which confines the real Claude CLI under `scripts/desktop/claude-runner.sb` via `sandbox-exec` with a per-run isolated profile under the data dir. `providers.ts` wires `desktopClaudeRuntime(connection.id, connectionEnv(agent).CLAUDE_CODE_OAUTH_TOKEN ?? '', CLAUDE_HARNESS_ENV)` at the desktop provider points (lines 484/538), and `auth.ts` runs `beforeCredentialChange: stopDesktopClaudeWorkers` so a credential replacement drains the confined workers first. That runner/sandbox boundary is the subject of this lane's fixture; the sign-in exchange itself stays synthetic.

## What the fixture proves (deterministic, inert)
A compiled native Mach-O fake (`fake-claude.c` — a shell script cannot exec under `claude-runner.sb`, which denies `process-exec` except the BINARY literal) is built at test time via `/usr/bin/xcrun clang` (repo precedent: `skill-publication-native.test.ts`) and copied beside the **exact production policy bytes** of `scripts/desktop/claude-runner.sb`. All paths are realpath-canonical because `trusted()` rejects any path whose realpath differs (the `/tmp -> /private/tmp` link would break the sandbox's literal BINARY match — verified empirically). The fake speaks a tiny line protocol (ping reports the credential generation: revision + token bytes + byte sum + hasToken + ambient env presence; echo/echo-b64/echo-hex/echo-stderr are redaction probes; quit exits 0). It never execs, forks, writes files or touches the network.

- Gate and untrusted refusals: wrong connection id, missing availability (app flag, relative runner path), empty token, control-character tokens -> `Connect Claude in Settings before chatting.`; symlinked runner, non-canonical (`/var` vs `/private/var`) runner and sandbox paths -> `The bundled Claude runtime is unavailable.`
- Reopened exact credential generation (`synthetic-fixture-token-generation-2`, revision `2`) goes to **one confined child**: the same child answers repeated pings, `Stop` (`stopDesktopClaudeWorkers`) SIGTERM-drains it (`{code:null, signal:'SIGTERM'}`), the process group is gone, and a reopened runtime spawns a **different** confined child that reports the same exact generation. Ambient SDK env (`NODE_OPTIONS`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `HTTPS_PROXY`) never reaches the child (`ambient: 0`).
- `quit` exits cleanly; `abort` on the spawn signal drains the child (SIGTERM); `close()` is idempotent and removes the profile (`readdir(data/claude)` empty); `stopDesktopClaudeWorkers()` covers both paths.
- Redaction runs through the **real filtered pipes**: raw token, base64, hex and URI-encoded variants all come out `[redacted]` on stdout and stderr, and none of the variants appear in collected output.
- A closed runtime, a foreign `command`, a foreign `cwd`, and an aborted turn all refuse with `Claude process owner changed` / AbortError **before spawning any child**; after close the same generation cannot be re-admitted (no replay) and no profile is recreated.

## Changed files / authored regressions
- `apps/engine/src/desktop/claude-plan/fake-claude.c`: inert native fake CLI source (compiled at test time; protocol verified under the real `claude-runner.sb` via `sandbox-exec` with canonical paths).
- `apps/engine/src/desktop/claude-plan/bundled-runner.test.ts`: the five regressions above against the real `desktopClaudeRuntime`/`stopDesktopClaudeWorkers` with the fake executable and fake credentials.
- this handoff.

Existing `runtime.test.ts` (spawn-spec shape + output-filter unit) is untouched; `auth.test.ts` (singleton custody), the mounted `DesktopClaudeMountedReconnect.test.tsx`, and provider-side wiring are untouched. Singleton policy is exercised only through the module-level worker registry `stopDesktopClaudeWorkers`; real Claude sign-in, provider calls, encrypted disk custody and the OAuth exchange remain root acceptance gates.

## Integration and remaining gates
No new mount, route, registry, provider, default, migration or production source change. The runtime boundary is unchanged; the fixture only drives it. Root owns all test execution/builds and integration review; no tests, typecheck, lint, formatter, build, install or native QA ran.

Root QA steps:
1. Run `apps/engine` vitest for `claude-plan/bundled-runner.test.ts` on this tip (compiles `fake-claude.c`, copies `scripts/desktop/claude-runner.sb`, runs the five fixtures).
2. Negative controls: run `runtime.test.ts` and `auth.test.ts` (untouched) to confirm no cross-talk; confirm `bundled-runner.test.ts` on parent (`d518abdb`) fails to resolve the new files only because they are not present.
3. Mac board real-account steps (separate authorization, not required by this fixture): connect Claude, confirm the bundled runner spawns one confined `claude-runner.sb` child per run with the signed-in token and no ambient SDK env, Stop/quit drains the process group, reconnect after a credential replacement keeps the new generation, and a rejected credential cannot spawn a run.

Limits: fixture uses synthetic credentials and a synthetic harness env carrying `RERUN_CLAUDE_CREDENTIAL_REVISION`; it does not run the real CLI, the real OAuth exchange, provider admission or encrypted disk custody. Live account, provider, Keychain/permission and sandbox behavior on a real app bundle are unverified. No real account login, provider call, push, PR, installation, VM or permission changes.
