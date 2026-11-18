# rerun-mobile (apps/mobile)

The Rerun app for iPhone, iPad and Android, built with Expo and Expo Router. It talks to a hub
(`apps/ui`) through its `/api/v1` routes and signs in with Supabase, like the web app. It shares
`@rerun/contracts`, `@rerun/db` (types only) and `@rerun/i18n` with the rest of the monorepo. In this
fork `@rerun/contracts` resolves to `packages/hub-contracts`, upstream's contracts as the app was
written against them; the Mac app's own contracts are `@rerun/mac-contracts` here.

## Run it

From the root of the monorepo, on a Mac with Xcode (and the Android SDK for `--android`):

```bash
pnpm dev:mobile                  # the iOS simulator
pnpm dev:mobile --device         # the paired iPhone, signed with the Apple ID added in Xcode (a free one works)
pnpm dev:mobile --android        # an Android emulator
pnpm dev:mobile --rebuild        # force the native build instead of reusing a cached dev client
```

The script builds a development client (cached by its native inputs: `package.json`, `app.json`,
`app.config.ts`), starts Metro, and starts the hub of this checkout on port 3050 (or `CONDUCTOR_PORT`)
unless it already answers there. Metro takes the hub port + 2. Details at the top of
`scripts/dev-mobile.mjs` and `scripts/dev-mobile-android.mjs`.

## Which server the app talks to

`apps/mobile/.env` (from `.env.example`) holds the Supabase pair the app signs in with,
`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Set `EXPO_PUBLIC_API_URL` there to
use a deployed hub: `pnpm dev:mobile` then starts no local hub.

At launch, `src/config/environment.ts` picks the server:

- a server the person picked in the app (**Use your own server** on the sign-in screen) comes first;
- otherwise a store build follows its update channel, `production` or `staging`;
- otherwise (a development build) the `EXPO_PUBLIC_*` values.

A self-hosted install needs nothing in the build: people type its address in the app. See
`apps/docs/self-host/mobile.mdx`.

## Paired with the Mac app

**Connect to This Mac** on the sign-in screen pairs the phone with the Rerun Mac app on the same
network, with no account and no hub. On the Mac: **File → Connect iPhone…**, allow local pairing, pick
the network address, create a pairing offer. On the phone: scan the QR code, or paste the code under
it. The Mac then lists the phone under *Waiting for approval*; once approved there, the app restarts
on the Mac. Sending is off until **Send messages** is turned on for the phone in the same Mac window.

How it is built (`src/mac/`):

- `@rerun/mac-pairing-client` speaks the Mac's phone listener (`/api/mac-pairing/v1`); the wire shapes
  are `@rerun/mac-contracts/mac-phone-pairing` (`packages/contracts/src/mac-phone-pairing.ts`).
- The listener serves HTTPS with a certificate the Mac made for itself. `modules/mac-pairing-transport`
  (Swift and Kotlin) only talks to a server presenting the certificate named in the offer. Without
  that module (Expo Go, the tests) pairing over the network is refused. On iOS it opens the connection
  with Network.framework and speaks HTTP/1.1 itself: through URLSession, App Transport Security refused
  the Mac's certificate at a Tailscale address, and no ATS rule is loosened for it. Its HTTP part is
  checked on a Mac with `sh modules/mac-pairing-transport/tests/run.sh`.
- `session.ts` reads the pairing at launch, like the custom server: `environment.name` is `mac`, and
  `MacAuthProvider` stands in for the Supabase session. The phone's token lives in the Keychain under
  `rerun.mac-pairing.session`, apart from `rerun.server` and from a hub's session.
- `hub.ts` answers the `/api/v1` paths the Home and the chat read with what the Mac serves, and
  `chat-transport.ts` sends through the Mac and follows the reply. `useLiveReload` polls instead of
  listening to Realtime.

What a paired Mac serves: the coworkers of the one workspace the phone was approved for, their saved
chats as text, a new conversation, a message, the live text of the reply to a message the phone sent,
stop, and the question or approval a chat waits on. A question is answered from the phone when the
phone may send: the Mac records the answer against the question it saved, the way its own form does,
and takes nothing else in that chat until then. An approval is shown and decided on the Mac, unless the phone may approve requests. The Mac's
Actions inbox is served too.

Tap a coworker’s name in its chat to open its Mac settings. All approved phones can read them.
Turn on **Change settings** for the phone in **File → Connect iPhone…** on the Mac to edit its
profile, model, reasoning effort, tools, allowed coworkers, Box or setup. Permissions that reach
the Mac ask for confirmation before the phone turns them on. Vault entries, provider sign-ins,
MCP secrets and service accounts can be configured only on the Mac.

The Chief of Staff (the Foreman's page here) is served from the Mac: General and its task threads as
text, a message, a new task thread, the live text of the reply, stop, and its question card, for a
phone that may send (any approved phone reads). While the Mac's Chief of Staff still asks its first-run
company questions, the page says to finish setup on the Mac. Its cards that change things (a plan to
build, team changes, a starter pack) are words with "Open on your Mac to approve", and its approvals
stay on the Mac. For a proposed setup reply the phone also shows the saved question, the full reply,
and **Open setup for [coworker]**. That button reads the current setup and opens its chat. The owner
can answer directly there with the phone’s existing permissions. When setup needs the owner’s
original question or sign-in, the same shortcut opens the saved setup chat.

Not served, and hidden or answered "not available": new coworkers, files and attachments, voice
(for the Chief of Staff, the composer and its question card offer no recording), routines (the Chief
of Staff's included), apps, AI providers, search, feedback, push.

A build with no hub configured (`EXPO_PUBLIC_*` unset) still opens, so it can pair with a Mac.

## Build profiles

`eas.json` defines the EAS builds:

| Profile | What it builds |
| --- | --- |
| `development` | a development client: iOS simulator, Android APK installed beside the store app as `build.rerun.app.dev` |
| `simulator-lab` | the development client on the `preview` EAS environment |
| `staging` | a store build on the `staging` channel |
| `production` | a store build on the `production` channel |

## Open source and Rerun Cloud

Like the web app, what Rerun Cloud runs differently is imported from `@rerun/cloud-mobile/<module>`.
Without the private `cloud/` folder it resolves to `src/cloud-oss/` (`paths` in `tsconfig.json`,
`jest.resolver.js` for the tests). A fork builds with its own EAS project (`EXPO_OWNER`,
`EAS_PROJECT_ID`), and a `staging` or `production` build without `cloud/` fails unless its EAS
environment sets `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL` and
`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`app.config.ts`).

## Scripts

Run from `apps/mobile`, or from the root with `pnpm --filter rerun-mobile <script>`:

| Script | What it does |
| --- | --- |
| `start` | `expo start` (Metro alone) |
| `ios` | `expo run:ios` |
| `test` | Jest, every test run once as iOS and once as Android |
| `lint` | `expo lint` |
| `ts-check` | `tsc --noEmit` |

End-to-end flows (Maestro) live in `.maestro/`, with their own README.

## Rules

`AGENTS.md` in this folder: the app is on Expo SDK 58, read the versioned Expo docs before writing
code. The strings go through `@rerun/i18n` (`src/i18n/`), and the languages the system settings offer
are `APP_LANGUAGES` in `app.config.ts`.
