# Standard for Rerun agent assignments

The user requested on November 5, 2026 that the complete task-list format used for the additional webhook/trigger agent become the standard for **all A–H assignments**. The additional full-list agent is now **I**, and follows the same standard.

Each agent receives a substantial coherent feature package from the parity checklist, with the complete owned lifecycle and useful regression source. Choose the task count by the work required, normally around eight to ten concrete steps; do not split a feature into artificial one-function assignments or add unrelated work to fill a quota.

Every assignment states:

1. The product outcome, checklist IDs, exact prepared worktree, branch and base.
2. Original Rerun source references at the pinned revision, with components, labels, ordering, interactions and responsive design to reuse.
3. A complete numbered implementation list covering the owned behavior, not just a scaffold or UI shell.
4. One canonical typed contract, trusted owner identity, explicit dependencies and integration callbacks.
5. Durable persistence, restart reconciliation, duplicate/lost-ack recovery, error/Cancel/Stop and stale-response behavior as applicable.
6. Exact owned paths, forbidden shared paths and neighboring agent boundaries. Larger lists do not authorize overlapping worktrees or parallel edits to shared files.
7. Meaningful regression sources and an implemented/unsupported/dependent matrix. Agents author source; root runs all tests, type checks, lint, builds, packaging, live requests and Mac/restart checks.
8. A complete local commit handoff: full SHA, worktree status, changed files, original source mapping, precise root wiring and honest limitations. No push, merge, publishing or acceptance claims.

Root integrates, fixes every discovered issue directly, and validates the installed Mac app from the board and after a full restart. A group is checked off only when its recorded scope passes acceptance. Partial progress is recorded without silently changing the count.

Round35 integration lessons apply to subsequent packages:

- Use the existing authenticated desktop route and its public DTO. Upstream web endpoints and internal engine records are not interchangeable with the Mac boundary.
- Keep network requests and live authority checks outside database write transactions. Recheck identity before committing; concurrent readers must remain able to observe progress.
- Persist recovery identity in the canonical workspace store. A loopback origin, renderer state or successful-looking UI message is not durable evidence of a completed action.
- Make confirmed cleanup repeatable for the exact runtime lifetime. Close subscriptions and event streams during shutdown; retain failed or uncertain cleanup for retry instead of reporting success.
- Give every non-send control inside a composer form an explicit non-submit button type. Recording, playback, setup and discard must preserve any unrelated text draft.
- Distinguish original behavior from intentional Mac additions and unavailable connected services. Preserve committed effects when dismissing a review, and never repeat them after a lost acknowledgement or restart.

For assignments already underway, expand the description within the existing contract and ownership. Do not reset worktrees or imply that a revised prompt has been dispatched. New wider scope requires a separate allocation that avoids work already assigned.

Updated-source reference (November 6): fork `2a57fa6dd53311f763bfc9abde85997b7f7e5309` is now the comparison target; `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` remains the historical acceptance pin. Read `docs/desktop-upstream-review-20261106.md`. For a new allocation, include the reviewed-source references in its prompt. Do not require a busy agent to receive a mid-task update; root reconciles completed handoffs against newer source while preserving their exact bases and ownership. Keep AGPL core/community source separate from commercial `ee`/`(ee)` modules; root allocates appended migration versions and composes shared patches. New source availability is not installed acceptance.
