# @rerun/mac-pairing-client

The **Connect to This Mac** preview runs against a listener on `127.0.0.1`.
Open **File → Connect iPhone…** in the Mac app to allow local pairing and
approve a test client. The client can list coworkers and read saved chat text
in the workspace approved on the Mac. Mac-paired sessions have their own
storage key, separate from cloud and self-hosted Supabase sessions.

A physical phone needs a matching iPhone app and a secure local-network
transport. The existing iPhone server picker requires a Rerun hub with
Supabase authentication.

## Why the stock iPhone app cannot sign in to the Mac unmodified

Traced against upstream `rerun-build/rerun` at `5222e8486cd7e0e10001ad89b3602a9aa4ebf7f4`:

1. **Server picker UI.** `StartStep` (`apps/mobile/src/components/auth/steps/StartStep.tsx` lines 109-143) shows "Use your own server" (`mobileAuth.start.ownServer`) and, once a custom server is stored, email-only sign-in. `ServerStep` (same folder, `ServerStep.tsx` lines 14-49) collects an address. `useServerConnect` (`components/auth/useServerConnect.ts` lines 7-32) normalizes it and calls `lookUpServer`, then `switchServer`.
2. **Lookup.** `lookUpServer` (`apps/mobile/src/config/server-connect.ts` lines 59-76) GETs `/api/v1/client` and requires `clientConfigSchema` (`packages/contracts/src/client.ts` lines 25-39): `{ minBuild, server?: { supabaseUrl, supabasePublishableKey } }`. Missing `server` is treated as an outdated hub (`'outdated'`). The phone then reloads with those values as its environment (`config/environment.ts` lines 28-36, `config/custom-server.ts` lines 5-29, stored under `rerun.server`).
3. **Hub response.** `GET /api/v1/client` (`apps/ui/app/api/v1/client/route.ts` lines 34-41) is public and returns the hub's `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Loopback Supabase URLs are rewritten to the Host the phone used (lines 19-32).
4. **Supabase sign-in.** `apps/mobile/src/auth/supabase.ts` lines 9-11 create a `@supabase/supabase-js` client against that project. Phone codes go through `/api/v1/auth/phone/code` and `/api/v1/auth/phone/session`, then `supabase.auth.setSession` (`auth/sign-in.ts` lines 36-46). Email codes use `/api/v1/auth/email/code` and `supabase.auth.verifyOtp` (lines 51-62). Sessions are persisted in SecureStore (`auth/secure-storage.ts`).
5. **Bootstrap.** After a token exists, `AuthProvider` (`auth/AuthProvider.tsx` lines 38-51) POSTs `/api/v1/bootstrap` (`auth/sign-in.ts` lines 64-66), which provisions the user and returns `meSchema` (`packages/contracts/src/me.ts` lines 6-18). Workspace-scoped calls send `Authorization: Bearer <supabase access token>` and `x-workspace-id` (`api/client.ts` lines 36-42).
6. **Workspace-scoped reads.** Coworkers come from the board / agents APIs (`data/useWorkspaceAgents.ts` lines 10-29, typically `/api/v1/agents`). Saved chats are `GET /api/v1/agents/:id/conversations` and `GET /api/v1/conversations/:id/messages` (`api/chat.ts` lines 11-17). Members are `GET /api/v1/members` (`api/members.ts` lines 7-9). Workspaces are `GET /api/v1/workspaces` (`api/account.ts` lines 11-13).

The native Mac app is not a Rerun hub and has no Supabase project. Inventing `supabaseUrl` / `supabasePublishableKey` would still fail OTP, `setSession`, token refresh, and bootstrap, because those require a real GoTrue/Supabase user store. A dedicated Mac pairing mode therefore replaces that chain rather than pretending to satisfy it.

## How the stock app would wire this package

Keep the existing cloud and "Use your own server" paths untouched. In `StartStep` (lines 135-142), add a sibling of the `ownServer` `TextLink`:

- Label: "Connect to This Mac".
- Action: `goTo({ name: 'mac-pairing' })`, **not** `switchServer(...)`.
- New step: paste or scan the Mac offer (JSON or `rerun-mac://pair?...`).
- Call `createMacPairingClient({ storage: SecureStore }).connectToThisMac(offer)` and `waitForApproval()`.
- Persist only under `rerun.mac-pairing.session` (`PHONE_SESSION_KEY`). Never write `rerun.server`, `rerun.workspace-id`, or supabase-js keys.
- After approval, list coworkers and open a saved chat through this client. Do not send those reads to `/api/v1/*` and do not attach a Supabase JWT.

`startSignInEntries()` returns the three entries in the intended order: cloud, own-server, this-mac.
