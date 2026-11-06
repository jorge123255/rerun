# WhatsApp Status source handoff

Source only. Not validated. No tests, typecheck, lint, build, install, provider call, account connection, or WhatsApp post was run. No PASS and no installed-runtime claim.

## Identity

| | |
|---|---|
| Base | `8297fe6404caa114dcb0c2cd6006291a8abb2038` on `desktop/finish-cloud-base-20261106-8297fe64` |
| Implementation | `e7e2286e2f43d4bfed69e2925f28b0aaed2341b5` |
| Branch | `cursor/whatsapp-status-up03-8cc8` |
| Original | `ab3def9bfcf545cc9548f99c63c2b011ca094023` `apps/ui/lib/apps/whatsapp/tools.ts` tool `post_status` |
| Linkup operation | category `content`, action `create`, client path `POST /v2/content` on `https://api.linkupapi.com` (`apps/ui/lib/apps/linkup/client.ts` `runAction` at that pin) |
| Model name | `whatsapp_pro_post_status` |

`e7e2286e2f43d4bfed69e2925f28b0aaed2341b5` contains the adapter, contract, presenter, unrun test, and the first copy of this handoff. Any later commit on this branch that only records that SHA is documentation. The branch is not `main` or `dev`.

## What landed

- `packages/contracts/src/desktop-whatsapp-status.ts` is an additive contract. `packages/contracts/src/index.ts` was not edited.
- `apps/engine/src/desktop/whatsapp-status/schema.ts` mirrors that contract so the engine typecheck does not depend on the barrel.
- `apps/engine/src/desktop/whatsapp-status/status.ts` is the gated adapter and `desktopWhatsappStatusTools`.
- `apps/engine/src/desktop/whatsapp-status/status.test.ts` is authored and was not run.
- `apps/ui/components/desktop/whatsapp-status/DesktopWhatsappStatusSetup.tsx` shows the original description, field order, and field copy. It has no post action.

The tool stays unregistered unless the coworker is enabled, the existing `services` grant is on, and `readBinding` returns `phase: 'ready'` with an account id and connection id. The default ports report `credential-missing` and do not dispatch. There is no new API key field, no new host, and no second credential store. `whatsappStatusCompilerGate` does not mark a local MCP method as supported. Do not set the community paid-app flag to true.

A live Linkup account was not chosen. Root still has to decide which existing Apps account, if any, may be selected. Source does not invent that account.

## Root activation fragments

Do not edit these in parallel with other owners. Apply them in one integration pass.

`packages/contracts/src/index.ts`, next to the other desktop exports:

```ts
export * from './desktop-whatsapp-status.js'
```

Rebuild `@rerun/contracts` after that line. Then the engine schema file can be deleted and `status.ts` can import from `@rerun/contracts`. Until then the local schema mirror is the runtime copy. The unrun test compares the two.

`apps/engine/src/tools/registry.ts`, inside `desktopApp()`, after the existing service tools are assembled and only with ports root implements:

```ts
Object.assign(tools, await desktopWhatsappStatusTools(ctx, whatsappStatusPorts))
```

Import `desktopWhatsappStatusTools` from `../desktop/whatsapp-status/status.js`.

`whatsappStatusPorts.dispatch` may call the existing Linkup `runAction(accountId, 'content', 'create', params)` only when all of the following are true:

- `LINKUP_API_KEY` is already in the server environment that the original client reads. Do not add a desktop key column.
- `accountId` is the selected Apps connection for this coworker, not a value from the model.
- The call uses category `content` and action `create` only.
- `signal` is the run abort signal.

If any of those are missing, return `{ phase: 'disabled', reason: 'credential-missing' }` or `capability-off`. Do not catch a dispatch failure and call `runAction` again. Map an aborted signal after the request has left to `uncertain`. Map a Linkup body that does not contain a status id, an audience count, and an expiry to `uncertain` rather than inventing those fields. The original tool file does not name the response keys.

`classifyDesktopServiceMethod` stays as it is. Paid-app methods remain unsupported local MCP methods. Do not add `whatsapp` to `desktopRerunGrantIds`.

Mount `<DesktopWhatsappStatusSetup binding={binding} />` from the existing Apps surface for the WhatsApp catalog entry. Pass the same binding the ports reader returns. Do not add a composer send button, a webhook, or a pairing listener.

## Authority constraints

- Original parameters, in order: `message`, `file`, `phone_numbers` (max 500), `background_color` (`#` plus six hex digits), `font` (integer 0–5). Unknown keys, including `account_id`, are rejected.
- Empty text and no file is refused before dispatch. A file must be an `http` or `https` URL without userinfo. That check is a Mac bound; the original schema only typed `file` as a string.
- Stop before dispatch is `cancelled` and does not call the port. Stop after dispatch starts, a thrown port, or an incomplete receipt is `uncertain` and is not retried.
- Disabled reasons copy: unbound, capability off, credential missing, revoked. None of them call the port.
- The model text for a post contains the status id, the audience count, and the expiry. It does not echo the phone list or the status body.
- No account was created or connected. No status was posted.

## Authored tests, not run

`apps/engine/src/desktop/whatsapp-status/status.test.ts` covers: contract parity, parameter filtering, empty and illegal inputs, all four disabled reasons, one `content`/`create` dispatch, thrown and incomplete receipts, cancel versus uncertain stop, hidden tool until Apps and a ready binding, and the compiler gate staying closed.

## Checks not run

Tests, typecheck, lint, build, install, dependency preparation, formatters, app UI, native, browser, database, Keychain, provider probes, account login, network activation, listeners, permission prompts, restart, signing, and release.
