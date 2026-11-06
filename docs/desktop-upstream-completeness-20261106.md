# Rerun public-source completeness check — November 6, 2026

The whole public Git-tracked fork snapshot is present locally: **4,244 entries, zero missing tracked objects at these pins, no unresolved Git LFS pointers and no submodules**. Every one of the **1,839 changed paths** since the earlier source pin is accounted for in the inventory. That verifies source retrieval and file accounting; it does not mean every line was reviewed or every feature was ported/tested.

## Exact snapshots

| Scope | Pinned source | Entries | Changed paths vs old pin | Missing objects |
|---|---|---:|---:|---:|
| User fork `main` | `2a57fa6dd53311f763bfc9abde85997b7f7e5309` | 4,244 | 1,839 | 0 |
| Official `dev/master/staging`, observed together | `ba28349aab019ea87cc6fa33bf3bbf4794e5195c` | 4,245 | 1,847 | 0 |

The official repository moved during the review. The newer observed revision also adds the master-push open-source release/version workflow, beyond the previously recorded phone, Linux update and cron changes. These are immutable observed snapshots, not a promise that a moving branch stays unchanged. Unmerged personal feature branches are not silently adopted as the product reference.

[Complete path/object/change inventory](</Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/outputs/Rerun complete public source inventory.json>) records every tracked path, blob ID, size, domain and change classification. The original broad [source/design review](</Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/outputs/Rerun upstream review November 6.md>) remains the feature-level starting point.

## Full changed-path accounting at the fork pin

| Source domain | Changed paths |
|---|---:|
| analytics | 3 |
| commercial-ee | 150 |
| community-adapters | 38 |
| contracts | 28 |
| database-package | 3 |
| documentation | 20 |
| emails | 51 |
| engine | 190 |
| github-workflows | 6 |
| hub-api | 167 |
| mobile | 407 |
| rest-v1 | 95 |
| root-config-and-other | 27 |
| scripts | 8 |
| shared-ui | 22 |
| supabase-schema-rls | 11 |
| web-other | 395 |
| web-ui | 218 |

These counts include source, tests, assets and configuration. They are not feature counts. A citation or domain review records the code inspected; uncited inventory entries are not represented as individually audited.

## Additional material scope found by the completeness review

- **REST v1 and client compatibility.** The iPhone client has a substantial authenticated REST backend, distinct from the external MCP API: bootstrap, workspace selection, coworkers/chat/files/routines/services, connections, devices, remote desktop and account operations. Mobile transport is separate future scope; B/C/D external MCP must not be mistaken for REST compatibility. [Source](https://github.com/jorge123255/rerun/blob/2a57fa6dd53311f763bfc9abde85997b7f7e5309/apps/ui/app/api/v1/_lib/api-route.ts#L10).

- **Execution-level Box and member access.** Role/grant migrations govern sessions, notifications and other data as well as board controls. callableAgentIds propagates the visible coworker scope into the engine; disabled buttons alone cannot implement it. This extends W2/B2/B5 and external-key authority. [Source](https://github.com/jorge123255/rerun/blob/2a57fa6dd53311f763bfc9abde85997b7f7e5309/packages/contracts/src/chat.ts#L23).

- **Realtime and feedback privacy.** Cursor broadcast/presence becomes membership-authorized private Realtime. Feedback contains copied transcripts and loses direct browser-readable access. These are collaboration/privacy acceptance requirements, not just new visuals. [Source](https://github.com/jorge123255/rerun/blob/2a57fa6dd53311f763bfc9abde85997b7f7e5309/supabase/migrations/20261105150000_message_feedback_private.sql#L1).

- **Fork CI/release behavior.** The supplied CI and release jobs are gated to the official repository. A fork containing these files does not automatically execute their checks. The migration CI job resets the DB but does not itself execute every supplied SQL policy test. Root retains actual verification. [Source](https://github.com/jorge123255/rerun/blob/2a57fa6dd53311f763bfc9abde85997b7f7e5309/.github/workflows/ci.yml#L15).

- **Community email and push availability.** Transactional application email has a public Resend adapter requiring the deployment’s own configuration. Invited-publication codes depend on it. Self-host push is explicitly a no-op, despite mobile device-token source. Source presence is not configured delivery. [Source](https://github.com/jorge123255/rerun/blob/2a57fa6dd53311f763bfc9abde85997b7f7e5309/apps/ui/cloud-oss/email.ts#L8).

- **Truthful external reads and shared chat details.** get_agent now exposes unavailable[] to distinguish failed reads from empty collections. Shared HITL headers/described choices and quick-reply value handling are additional focused chat/catalog follow-ups. [Source](https://github.com/jorge123255/rerun/blob/2a57fa6dd53311f763bfc9abde85997b7f7e5309/apps/ui/app/api/_services/mcp-account.service.ts#L324).

- **Paid-data attribution contracts.** Catalog/pricing and table/cell provenance schemas are public source, while service delivery, commercial boundaries and hub dependencies remain separate. They are not accepted local tools merely because a schema exists. [Source](https://github.com/jorge123255/rerun/blob/2a57fa6dd53311f763bfc9abde85997b7f7e5309/packages/contracts/src/paid-data.ts#L1).

Two apparent additions are documentation corrections: the MCP docs now say 53 tools, but both pins already contain the same 37 account, 12 template and 4 sharing definitions; rename/reference rewriting and the documented result caps also already existed at the earlier pin. They must not inflate the remaining-feature count.

## Public versus private source

The complete public Git-tracked trees at the stated pins are accounted for locally. Optional private `cloud/` code is excluded by its repository and installed only if separately present; it was not fetched. The main AGPL source and new commercial `ee`/`(ee)` source also have different license boundaries. A full public clone is not all private Cloud implementation, hosted credentials, deployed services or mobile signing/push configuration.

## Current work and acceptance

Leave A–I on the prompts they already received; no interruption, reset, rebase, replacement lane or mid-task update is required. Root will reconcile each completed handoff against these pinned source findings and perform any necessary integration repair. The existing addendum is a future/reference artifact, not a dependency the user must deliver to busy agents.

C35 is now a committed handoff: implementation `1e758a28bddd7236e5367496482f8350cdfc25cd`, docs tip `8c1d6b3dff7297668d74dbaff6dfd54703d5408a`. C35’s committed handoff is integrated with root repairs in installed source `7b6c6a101519bdb7482169871270c77a76af0dcc`. Full UI **6,275 tests** and engine **4,138 tests** pass. Native intake draft/save, navigation, Skip and cold-restart checks passed. Final live completion/reply is pending ChatGPT approval in isolated workspace 2. E11 remains open. Existing agent assignments stay unchanged; no mid-task update is required. Source retrieval and agent completion are not full installed Mac acceptance.

The historical 21-group checklist remains a subtotal for the earlier source target. New gaps are mapped into existing groups where appropriate; new platform/provider scope is recorded separately until the updated parity audit derives the total. Root continues to own all tests, builds, app installation and board/restart QA. No checks, hooks or app code from the updated upstream source were executed for this inventory review.
