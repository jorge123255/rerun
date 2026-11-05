# Desktop workspace logo from a website or link

Source integration of the original “Logo from a website or link” field into workspace settings
(the B5 link slice, alongside the accepted illustration/upload choices). Root owns every check
and Mac acceptance decision; this document does not claim execution or live acceptance.

Lane base: `bb45f3a99e2ae2fe2de8e944a9eb4ab329ef0055`. Original handoff:
`3ff13530145e0a936ea7fec2acd628a70de333c3`, branch `desktop/workspace-website-logo`.
Its nine new files were imported into `desktop/m1`, corrected there, and wired into the existing
`DesktopWorkspaceSettings.tsx`. The author worktree remains unchanged.

## Original design and source

Original pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

- `apps/ui/components/dialogs/WorkspaceSettingsDialog.tsx`: field between name/upload and
  “Or pick an illustration”, globe and inline preview, one logo draft, manual choices clearing
  the address, and one name+logo Save with Cancel discarding the draft.
- `apps/ui/lib/workspace/logo-input.ts`: website versus direct-image classification and wording.
- `apps/ui/lib/onboarding/site-favicon.ts`: domain normalization and Google's public
  `https://www.google.com/s2/favicons?sz=128&domain=...` service.
- `apps/ui/lib/workspace/fetch-logo.ts` and `apps/ui/app/api/_actions/workspace.actions.ts`:
  fetch/rehost reference. Desktop uses its existing numeric-address-bound network policy and
  local atomic icon storage; it does not reuse the hosted fetch's separate DNS check/fetch.

## Integrated behavior

`lib/desktop/workspace-logo-link.ts` shares the original classifier between client and server.
Website links request the public favicon service; direct image links are fetched directly.
The original extension classifier includes SVG, ICO and GIF, but desktop preview clearly refuses
those formats: this slice accepts static PNG, JPEG and WebP only.

`DesktopWorkspaceWebsiteLogo.tsx` displays only local object URLs. Its callback is
`onSelection(selection: DesktopWorkspaceLinkSelection | null, pending: boolean)`; a successful
selection contains the exact reviewed `File` and `previewUrl`. Starting a new valid link clears
its previous selection immediately and reports pending; invalid input or failure reports no
selection. Supersession, disable and unmount abort pending reads, ignore late completions and
release obsolete object URLs. It rejects empty, oversized or unsupported-type preview responses.

`DesktopWorkspaceSettings.tsx` owns one current/catalog/upload/link/pending draft for both preview
and Save. Save is blocked while the new link is pending, including retained submit handlers.
Upload and illustration choices synchronously advance a generation and remount the field with
an empty address, so even a completion queued before unmount cannot replace the newer choice.
Returning after a cancelled Quit leaves a retryable field and does not permanently block Save.

A reviewed link uses the existing multipart `/api/desktop/workspace/icon` PUT, submitting the
exact reviewed file together with the name. The installed endpoint still owns full decode,
normalization to a maximum 256px WebP, atomic name+logo persistence, versioned descriptor and
bootstrap. Failed preview falls back to the saved icon; Cancel writes nothing. A failed Save
retains the reviewed draft for retry. No remote address is stored and no database, engine or
shell change is introduced.

## Network and image boundaries

`server/workspace-logo-fetch.ts` follows the accepted desktop web-fetch transport: public HTTP(S)
only, ports 80/443, no credentials, local/internal/trailing-dot hosts or reserved/private IPv4/IPv6
destinations. Every DNS answer must be public. Each connection uses the validated numeric address,
the original Host and TLS identity, `rejectUnauthorized: true`, `agent: false`, a 16KiB header cap
and identity encoding. No cookies, authorization, proxy or pooled-socket inheritance. At most
three redirects, each revalidated against fresh DNS. Content-Length is only an early rejection;
actual response bytes are capped at 8MiB.

Authenticated POST `/api/desktop/workspace/logo-preview` accepts strict `{ link }` JSON, counts
actual request-body bytes up to 8192, and persists nothing. One ten-second route deadline and the
client request signal cover request-body admission, DNS, redirects, body reads and waiting for
decode. Stalled body cancellation is observed without awaiting it indefinitely. Aborting destroys
the transport; late results cannot publish. A deadline returns 408, client cancellation 499,
oversize 413, and unsupported/damaged/animated content 415.

Preview validates content type and structural framing, animation, 8192px edge and 16,777,216-pixel
limits through `inspectDesktopImageBytes`, then forces a real Sharp pixel decode with the same
input-pixel cap. A maximum 256px raw derivative bounds output allocation and is discarded; the
response contains the unchanged original bytes. Sharp also receives a ten-second native processing
timeout and is destroyed on cancellation. Cancelling the JavaScript wait does not claim an
instantaneous interruption of native work; the native timeout and pixel bounds remain in force.
Response headers are private/no-store, nosniff, sandbox CSP and same-origin resource policy.

Google can be unavailable or return an unsupported format. The UI reports failure; it does not
promise placeholder-globe detection. Brand generation, SVG/ICO support and remote URL persistence
are outside this slice. No new dependencies were added.

## Authored regressions and acceptance boundary

- Parser classification and original website normalization.
- Pinned connections/redirects, private/mixed DNS refusal, byte/type/animation limits.
- Real valid image decode returning original bytes, metadata-readable corrupt pixel refusal,
  cancellation during a deferred decode, and no late publication.
- Authenticated route, bounded stalled/oversized bodies, never-settling cleanup, deadline and
  request cancellation, and observed late read failures.
- Child supersession with genuinely deferred responses, URL revocation and invalid responses.
- Actual workspace form: upload-to-link exact-byte atomic Save, link-to-upload/illustration
  supersession, failed replacement preserving the saved icon, Cancel/reopen isolation and Quit/Stay.

Tests are authored source only. No checks, builds, installs, public requests or native Mac actions
were performed by the integration helper. Root still needs to execute checks and validate public
website/direct-image flows, failed-preview preservation and persistence after restart.
