# Round 35 A — Foreman company research from public sources

Checklist E11. Source only. Root owns the barrel, the schema ladder, Foreman binding, routes, every check, and installed Mac acceptance. No test, typecheck, lint, build, install, server, network call, or packaging was run. This is not Mac acceptance. The checklist is not complete.

Worktree `desktop/round35-company-discovery` at base `5c0f589b51a8129d097f2b97fc420a8acf859b51`. Pinned original `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` is an ancestor. Agent B has no earlier company-discovery contract. This file publishes version 1.

## Original mapping

Read at the pin, then the current Foreman seam. Copy and grouping were kept. Paid collectors were not replaced.

- `apps/ui/lib/company/explore/`: collector order dns, stack, site, search, registry, linkedinPerson, linkedinCompany, googleBusiness, catalog, synthesis. They start together and each waits on `needs`. Timeout 240s. Events running, done, error, skipped, end.
- Original billing: dns free; stack free from the home HTML; site Firecrawl; search Firecrawl; registry free at `https://recherche-entreprises.api.gouv.fr/search`; LinkedIn person, LinkedIn company, and Google Business Apify; catalog Firecrawl except public Shopify `/products.json` and Woo `/wp-json/wc/store/v1/products`; synthesis is an LLM.
- `apps/ui/lib/company/explore/findings.ts`: a pending source adds `teaser:${source}` unless that source is already on the board. A finding replaces the teaser and upserts `finding:${kind}`. The same JSON does not bump arrival. Order is the teaser order plus rank. Dropped removes only the teaser. End clears teasers.
- `apps/ui/lib/company/explore/discoveries.server.ts`: dns emits mail plus tools except the mail provider. Stack emits tools except Framework, plus social and the first site name and description. Site emits social and a brand card from hex colors. Registry emits founded, headcount, and city only for a SIREN or officer match. Catalog falls through to no board cards. Product, competitor, customer, and audience cards come from synthesis. Icons come from the hosted `services` table.
- Labels and teasers in `COMPANY_DISCOVERY_SOURCE_LABELS` and `COMPANY_DISCOVERY_TEASERS` are that English copy. The site teaser still says “Reading every page” while this desktop reads the home page plus at most four more pages.
- Accepted confinement, reused and not loosened: `apps/engine/src/desktop/web-fetch/public-url.ts` and `readPublicPage` in `transport.ts`. Manual redirects, at most three, rechecked each hop. No cookies. Pinned certificate. Ports 80 and 443. Permission asserted each hop. Body cap 1_000_000 bytes. `PublicPage` does not expose arbitrary headers, so Vercel, Netlify, Cloudflare, and `x-shopid` header fingerprints are absent on purpose.
- Current Foreman discovery in `packages/contracts/src/desktop-foreman.ts` and `apps/engine/src/desktop/foreman/discovery.ts` still reads only a homepage identity as source `site` and marks every other source unavailable. That file was not edited. `collectDiscovery` in `apps/ui/lib/desktop/server/foreman/binding.ts` is still `null`, so Foreman still reports every source unavailable until root binds the adapter. That is the honest unbound state.

## What runs locally

| Source | This desktop | Original billing | Board |
| --- | --- | --- | --- |
| dns | Public MX, SPF, DMARC. Raw TXT tokens are dropped. | free | Mail card and other DNS tools. |
| stack | Home HTML fingerprints and meta. No header fingerprints. | free | Identity, tools except Framework, social. |
| site | Home plus at most 4 same-site category pages. Not Firecrawl map or branding. | firecrawl | Social, and a brand card only from a theme-color hex. Fonts stay empty. |
| registry | Only a SIREN found in page text. The public French API is queried, and the row is kept only when `siren` matches. No person-name query. | free | Founded, headcount, city. |
| catalog | Shopify `products.json` page 1 limit 50, Woo store API, or at most 4 JSON-LD pages. No Firecrawl fallback. | firecrawl | Payload is saved. Findings stay empty. Synthesis owns product cards. |
| profile | Unavailable, reason `welcome-card`. | welcome | Welcome card keeps the quick read. |
| search, linkedinPerson, linkedinCompany, googleBusiness, synthesis | Unavailable, reason `credentialed`. | firecrawl, apify, or llm | Not invented. `via: 'synthesis'` exists on a finding so B can attribute later. A does not emit it. |

## Contract

`packages/contracts/src/desktop-company-discovery.ts`. `DESKTOP_COMPANY_DISCOVERY_CONTRACT_VERSION` is `1`.

Identity is workspace id, chat `fmc_`, run id, and discovery `fmx_`. Events are `pending`, `unavailable`, `settled` (revision, status `found` | `failed` | `omitted`, reason, provenance, payload, findings), and `end`. `applyCompanyDiscoveryEvent` returns null for a duplicate pending, a duplicate unavailable, or a settled revision that is not exactly current plus one. Findings whose `source` differs from the event are ignored. `companyDiscoveryBoard` only sorts the saved entries. It does not fetch and it does not consume a revision.

`toForemanDiscoveryEvent` passes pending, unavailable, and end through. A failed settle becomes Foreman `dropped` with `timeout`, `blocked`, or `failed`. Only identity, audience, products, customers, and competitors project, and identity `logoUrl` is forced null. Mail, tools, social, brand, and registry stay on this snapshot. A settled source with none of the Foreman kinds projects as `dropped` / `empty`, including a catalog that saved products.

Limits in `DESKTOP_COMPANY_DISCOVERY_LIMITS`: 4 extra pages, 4 product reads, 25 products, 20 collections, 24 findings, 12 tools, 6 items, concurrency 2, 8 provenance rows, 200_000 HTML characters, 3 officers, 8s per page, 45s run deadline on the Foreman side.

The barrel was not edited. Root adds, and then rebuilds `@rerun/contracts` before typecheck:

```ts
export * from './desktop-company-discovery.js'
```

Until that export exists in dist, engine and UI imports of these symbols fail. Do not point them at a relative path outside the engine `rootDir`.

## Owned adapters

Engine, `apps/engine/src/desktop/company-discovery/`:

- `runCompanyCollectors` emits credentialed and profile unavailable first, then dns, stack, and site from one homepage read. Registry runs only after pages, only with a SIREN, and only if the signal is still live. Otherwise it settles `no-siren` and does not call the API. Catalog runs after that. A shop needs an e-commerce fingerprint or at least three product URLs. Admitted work drains after abort. Registry and catalog are not admitted once aborted. The `finally` settles anything still pending as `cancelled` or `failed`, and emits `end` only when the signal is not aborted.
- Revision numbers advance only after `companyDiscoveryEventSchema.parse` succeeds.
- `confinedCompanyReader(assertPermission)` and `confinedCompanyDns()` wrap `readPublicPage` and `publicDestination`. Parent abort is `cancelled`. The per-page `AbortSignal.timeout` is `timeout`. Private hosts, bad redirects, and unsupported types do not become findings.
- `readCompanyDiscoveryTarget` is the syntactic guard in the contract. `.example` is allowed. `.test` and literal private addresses are not.

UI server, `apps/ui/lib/desktop/server/company-discovery/`:

- `createCompanyDiscoveryRuntime({ store, authority, run })`. The UI package cannot import the engine, so `run` is a port with the `CompanyDiscoveryRunner` shape. A null authority throws `authority_unbound` before a row. A null `run` throws `fetch_authority_unbound` before a row.
- `collectForForeman` is the Foreman adapter. A missing workspace, chat, run, discovery id, url, signal, or emit throws `binding_unbound` before a fetch.
- Begin is idempotent for one workspace, chat, and run. A second begin returns the saved row and does not fetch. Stop aborts and awaits the in-flight promise. After drain, a still-running snapshot becomes `stopped` and the call throws `cancelled`, so Foreman's catch records stopped rather than `end` / done.
- Retry requires a UUID request id. The same request id returns the snapshot and does not fetch. A new id is stored, at most the last 20, before the fetch. The discovery id stays. Revisions continue at plus one.
- Startup `reconcile` sets running rows to `stopped`, drops teasers, and does not fetch or emit `end`.
- Reads filter workspace and chat. A corrupt body or an identity mismatch is `unknown`, not an empty success. A deleted, disabled, or replaced owner throws before a fetch. A read of a saved row may still return it with that owner state. Close aborts in-flight work. A later read is observational. Begin, stop, and retry then throw `closed`.
- The module never creates tables. `createCompanyDiscoverySqliteStore` uses a write transaction and a process-wide queue. Revision inserts are `ON CONFLICT DO NOTHING`.

## Root fragments, not applied

### Schema

This worktree's `round33-schema.ts` stops at version 24, `mcp-install-pending-inbox`. The integration tree already has version 25 `webhook-human-request-links` and version 26 `mcp-secret-reference-bindings` in `apps/ui/lib/desktop/server/round34-schema.ts`. Do not reuse 25. At integrate time the next free version is 27 unless a later lane took it. Suggested id `public-company-discovery`. Join `DESKTOP_COMPANY_DISCOVERY_SCHEMA_STATEMENTS` from `apps/ui/lib/desktop/server/company-discovery/store.ts`:

```ts
import { DESKTOP_COMPANY_DISCOVERY_SCHEMA_STATEMENTS } from './company-discovery/store'

{ version: 27, id: 'public-company-discovery', sql: DESKTOP_COMPANY_DISCOVERY_SCHEMA_STATEMENTS.join(';') }
```

Tables: `desktop_company_discoveries` (primary key `discovery_id`, unique workspace, chat, and run) and `desktop_company_discovery_revisions` (primary key discovery, source, and revision). Index `desktop_company_discoveries_chat`.

### Foreman collector

In `apps/ui/lib/desktop/server/foreman/authority.ts`, extend the input. Do not edit it in this lane.

```ts
export type ForemanDiscoveryCollector = (input: {
    url: string
    signal: AbortSignal
    emit: (event: DesktopForemanDiscoveryEvent) => void
    binding: DesktopForemanBinding
    discoveryId: string
}) => Promise<void>
```

In `startDiscovery`, pass the identity that was just saved:

```ts
else await collect({
    url: parsed.toString(),
    signal: controller.signal,
    emit: apply,
    binding,
    discoveryId: created.run.discoveryId,
})
```

Keep the null-collector branch that marks every source unavailable. Keep the `apply({ type: 'end' })` that follows a normal return: the company adapter also projects `end`, and a second end leaves a `done` row done. A thrown `cancelled` must still hit the existing catch and set Foreman status `stopped`. A thrown `binding_unbound` is not an abort, so that catch sets `failed`. That is the intended closed failure.

Set `collectDiscovery` in `apps/ui/lib/desktop/server/foreman/binding.ts` to `company.collectForForeman`. Leave `apps/engine/src/desktop/foreman/discovery.ts` as the old homepage path. It is not the new collector.

`apps/ui` does not depend on the engine. Implement `CompanyDiscoveryRunner` without a relative import into `apps/engine`. The engine exports `runCompanyCollectors`, `confinedCompanyReader`, and `confinedCompanyDns` from `apps/engine/src/desktop/company-discovery/index.ts`. The permission callback is the Foreman coworker's current `web_fetch` grant, the same check `readPublicPage` already takes. If that grant is missing, fail closed. Do not pass cookies, browser history, or ambient credentials.

One local shape that respects the package boundary is an engine route, allowed in `desktopRouteAllowed` and mounted beside `/desktop/foreman`, whose handler calls `runCompanyCollectors` and writes one `CompanyDiscoveryEvent` JSON line per emit. The UI `run` port is the client of that route and aborts with the Foreman signal. Do not add a public anonymous begin route. Begin only through `collectForForeman`.

### Routes

`companyDiscoveryHandlers(runtime)` returns `view`, `stop`, `retry`, and `reconcile`. Mount them with `desktopRoute`. Status codes from `CompanyDiscoveryError.code`:

| Code | HTTP |
| --- | --- |
| `authority_unbound`, `fetch_authority_unbound`, `binding_unbound` | 503 |
| `stale_workspace`, `stale_run`, `owner_deleted`, `owner_disabled`, `owner_replaced`, `conflict`, `closed`, `cancelled` | 409 |
| `not_found` | 404 |
| `private_target` | 422 |

Any other throw becomes 409 `conflict` with the fixed message and does not retry. Call `reconcile` at startup. `view` is observational. `retry` is the only explicit refetch.

Optional, and not required for the company snapshot: widen `foremanFindingSchema` if the live Foreman channel must show mail, tools, social, brand, and registry. Until then those cards are `companyDiscoveryBoard(snapshot)`.

## Persistence and recovery

Partial settles are written as they emit. A duplicate or historical revision returns false from apply and is not projected. Stop drains admitted work, then marks the company snapshot `stopped` without `end`. Restart reconcile does the same for rows still `running`, and does not repeat an external call. Retry repeats the external call only for a new request id, on the same discovery id. A corrupt snapshot is `unknown` and is not rewritten into an empty success.

## Unrun regression sources

Engine `apps/engine/src/desktop/company-discovery/collect.test.ts`:

- dns keeps the service name and drops the verification token
- source identity, provenance, and a repeated revision do not duplicate the card
- stop drains the admitted page and does not start the shop catalog
- an oversized page fails the site and keeps the dns card
- a malformed registry reply does not remove the pages already read
- a private address is refused before any read
- the bundled shop catalog records product names and does not invent a synthesis card

UI `apps/ui/lib/desktop/server/company-discovery/runtime.test.ts`:

- the same run is not fetched twice and a repeated source revision does not duplicate the card
- stop drains the admitted run and a later begin does not start another fetch
- startup stops a running discovery and does not fetch
- an explicit retry reuses the discovery and the same request does not fetch again
- a malformed source does not wipe an earlier card, and another chat cannot read it
- deleted owners, stale workspaces, private targets, and a missing authority do not fetch
- a corrupt saved body is unknown and is not treated as an empty success

These files import the new contract symbols. They cannot pass until root exports the barrel and rebuilds dist. They were not executed.

## Limits

No Firecrawl, Apify, or LLM. No search substitute. No header fingerprints. No raw TXT. No browser history, cookies, or ambient credentials. Catalog products are not board cards. Desktop icon URLs stay null. Fonts stay empty. The site teaser copy overstates the four-page cap. `.example` is a public documentation host. Service icons stay on the hosted `services` table, which this lane does not read.

## Owned paths

- `packages/contracts/src/desktop-company-discovery.ts`
- `apps/engine/src/desktop/company-discovery/**`
- `apps/ui/lib/desktop/server/company-discovery/**`
- `docs/desktop-round35-a-handoff.md`

Not edited: `packages/contracts/src/index.ts`, `apps/ui/lib/desktop/server/database.ts`, `round33-schema.ts`, Foreman runtime and authority, `apps/engine/src/desktop/foreman/discovery.ts`, routes, and the installed app.
