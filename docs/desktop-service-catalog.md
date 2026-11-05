# Desktop bundled service catalog

Server-only catalog of the 216 Rerun services in `supabase/seed.sql`. It does not connect, install, probe, or mark any service healthy. Root execution and native acceptance are pending.

## Provenance

| Field | Value |
| --- | --- |
| Source | `supabase/seed.sql` |
| Original pin | `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` |
| Seed git blob | `cc7201f8b16994132ee7698eb79c088891ada2b4` |
| Seed SHA-256 | `ebe7357ea24aa2788b93ce31d34f77a5dd067b349f4b9335d147579133257e33` |
| Catalog base | `447fb9f03cd1113d50d199a1ec4c433198dc0ef9` |
| Rows | 216, embeddings dropped |

Regenerate with `node apps/ui/lib/desktop/server/services/catalog/extract-seed.mjs`. The script fails if the pin, git blob, or SHA-256 changes. Runtime normalization uses `serviceManifestSchema` from `apps/ui/lib/services/manifest.ts`.

## What the catalog does

`apps/ui/lib/desktop/server/services/catalog/index.ts` exports:

- `listDesktopServiceCatalog({ query?, category?, offset?, limit? })` → `{ services, total }`
- `getDesktopServiceManifest(slug)` → frozen normalized manifest plus client details
- `getDesktopServiceMethodAvailability(slug, authMethodId)` → `{ id, supported, reason? }`

Enabled rows: 209. Disabled rows stay in the file and read as not found, matching hosted `loadManifest`: `dynamics-365`, `excel`, `linkedin`, `microsoft-teams`, `onedrive`, `sharepoint`, `vercel`.

Normalized methods: 273. The 209 enabled services expose 266 of those methods; 50 are supported and 216 stay visible with a reason. The 7 disabled services add the other 7 methods and are not listed. Supported does not mean installed or healthy.

List rows use the seed columns and the hosted literal rank (exact name, prefix, name, slug, summary), then English name. Default page size is 50. An unknown category, a bad offset, or a limit outside 1–500 throws. Detail name, summary, and description come from the normalized manifest. Canva is the one row whose column summary and manifest summary differ; both are kept.

Client details always use `installed: false`, `installStatus: null`, `instances: []`, and `key` equal to the bare slug. `verified` is the Rerun team badge from the seed column. There is no `health` on a catalog row. `DesktopServiceHealth` starts at `{ state: 'unchecked' }` only after E stores an install.

## Mac adaptations

- The hosted library reads Supabase and embeddings. This catalog is the extracted JSON, with no database and no `/api/embed` call.
- Hosted `getMethod` substitutes the default method when an id is missing. Desktop availability throws `Unknown auth method "<id>" for <slug>` instead.
- A flat manifest still normalizes to method id `default`. Microsoft Learn is that shape: kind `key` (because a server is present), zero inputs, one HTTPS server. Kind `key` is not a credential form when `inputs` is empty and `supported` is true.
- Anonymous support does not require kind `none`. Bearer support requires one server, explicit `transport: 'http'`, a canonical `https` URL with no userinfo, query, hash, or `${`, no `env` / `envKeys` / command / args, and exactly one required password secret whose header is `Authorization: Bearer ${input.THAT_KEY}`.
- `oauth: {}` is OAuth. Managed OAuth, Composio, paid `app`, SSE, stdio, custom headers, secret-in-URL, and any other bearer spelling stay unsupported.
- No seeded method uses paid `app`, an omitted transport, several MCP servers, or args without stdio. Those shapes still fail closed.
- Usage skills stay on the server manifest and are not installed here. A `${` placeholder in a skill blocks support. Render's skill mentions `Authorization: Bearer` in prose and stays supported. Unipile's skill contains `${input.UNIPILE_DSN}`; that method is already rejected for its query string.
- Icons stay the seed paths, including `?tone=dark` and `?tone=light`. Every path exists under `apps/ui/public`. `serviceIconProps` currently treats only `http(s)` as an image, so a `/services/...` path still falls through to the category icon until F renders a leading `/` as `src`.
- `apps/ui/AGENTS.md` points at `node_modules/next/dist/docs`, which is not installed in this worktree. This lane adds no Next route. The module follows the existing `import 'server-only'` desktop server files.
- Manifest objects are frozen. E copies a method with `structuredClone` before compiling it.

## Root fragment

`packages/contracts/src/index.ts`, next to the service export. This lane does not edit that file.

```ts
export * from './desktop-services.js'
```

Root rebuilds `@rerun/contracts` before typecheck. No new package dependency. The catalog imports `server-only`, `zod` through the existing manifest schema, and the source module `packages/contracts/src/desktop-services.ts` so it does not wait on that barrel.

## E and F consumption

E owns the routes. F owns the Apps client. Neither file is edited here.

```ts
import { listDesktopServiceCatalog, getDesktopServiceManifest, getDesktopServiceMethodAvailability } from '@/lib/desktop/server/services/catalog'
import { DESKTOP_SERVICE_HEALTH_UNCHECKED, desktopServiceMutationSchema, desktopServiceReadSchema, type DesktopInstalledServiceView } from '@rerun/contracts'

const availability = getDesktopServiceMethodAvailability(slug, body.authMethodId)
if (!availability.supported) throw new Error(availability.reason ?? 'Unsupported auth method')
```

POST body is `desktopServiceMutationSchema`: `install` with `requestId`, `slug`, `authMethodId`, and `values`, or `probe` / `disconnect` / `remove` with `requestId`, `key`, and `expectedRevision`. Unknown keys are rejected. `installed: true` means E has made the method usable now, and the response adds `key`, `revision`, and `health`. Disconnect removes local credentials and does not claim the remote token was revoked. Do not auto-enable a grant or expose publishing tools. Do not install skills except the ones on that service's manifest, and only for a supported method.

The first account key is the bare slug. Another account is `<slug>@<id>` with `id` matching `/^[a-z0-9]{6}$/`. The catalog does not allocate ids or revisions.

F should show an API-key field only when the selected method has inputs. Microsoft has none. Gate OAuth, managed, Composio, and paid-app buttons on `availability.supported` instead of opening the hosted connect flow.

## Limits

- 50 methods are eligible to try, on 50 enabled services. The other 159 enabled services have no supported method. None of the 216 is connected by this catalog.
- Microsoft Learn at `https://learn.microsoft.com/api/mcp` is the anonymous candidate. This lane did not call it.
- Header templates and Composio `authConfigId` values remain in the server JSON because they are already in the seed. Client list and detail objects do not include them.
- No install, credential write, database write, network call, or live health check happens in this module.
