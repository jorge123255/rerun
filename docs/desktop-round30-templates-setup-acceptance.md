# Round 30 Mac acceptance — templates, setup, suggested apps and images

Accepted November 5, 2026 for the delivered scope below. Root reviewed and repaired the exact integrated source, ran every execution check, installed the single signed preview, and exercised the Mac app from the board and through full quit/reopen. The final installed source is **aa35cc841b9d5c20246b4a095c910775af572d52** on `desktop/m1`; the later acceptance/assignment documentation does not change that artifact.

Coding checkout: `/Users/gszulc/OpenBot/Shared/rerun-desktop`. Clean build checkout: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/codex-login-build`, detached at the installed SHA. App: `/Users/gszulc/Applications/Rerun Desktop Preview.app`. Signing retained the established Developer ID identity, with deep strict verification before installation. No new Keychain prompt occurred during these updates/restarts. Nothing was pushed or published.

**B4 closes, reducing 23 open capability groups to 22.** W3, C3, C6 and C8 gained accepted slices and remain open for their wider scope. Root also accepted the original Control Center coworker Open → Install path under B5.

## Delivered work and root corrections

- **A/B: private local templates.** Original select/review/progress and library/detail flow captures instructions, confined selected text files and user-owned skills. Installation creates independent coworker identities with empty chats and capabilities off. Durable attempts reconcile lost acknowledgements and prior installations; explicit Use again creates another copy. Private history, credentials, memories and connection grants are excluded.
- **C/D: guided setup.** Original Setup fields/editor, Install/Continue/Skip gate and setup event cards use one claimed setup chat. Author Save records the author's setup; imported copies start pending. Only a live run in the claimed setup chat can complete it. Setup neither grants tools nor activates schedules/webhooks.
- **E/F: suggested apps.** Original ordered cards, exact coworker Apps navigation, decisions, Finish receipt and one follow-up use current authority and durable request identities. Needs you/Actions and notifications use the actual pending request. Finishing a decision does not grant a capability.
- **G: image result cards.** Existing own-file cards add bounded GIF/WebP and AVIF/ICO/BMP/static-SVG support through the original album and lightbox. Current file identity is revalidated; model image uploads remain a separate path.
- **H: still-image inputs.** Still GIF/AVIF/ICO/BMP and the accepted static SVG subset become immutable PNG model snapshots with original display names. Ordered draft/history/queue identities remain intact. Animated or unsafe inputs are refused.

Root corrected concurrency, retry, ownership, source-bound continuation, adoption and grant checks during integration. Mac testing exposed four additional defects, each repaired before final acceptance:

1. Reopening a captured template sent the whole list row to a strict detail endpoint. The client now sends only template ID/revision; the real library/detail flow was rechecked.
2. A fresh imported coworker had null setup and chat IDs, incorrectly bypassing the first Install gate. The pending gate now also handles an unclaimed setup chat. Native Start/Continue/Skip and real conversation regression sources cover it.
3. Optimistic converted-image cards briefly displayed internal PNG filenames. They now retain original display names during streaming as well as saved history, without changing snapshot URLs.
4. Closing/reopening the library lost the installation receipt, making Use again unreachable; a read-only durable lookup now restores it. The new copy was created natively after reopening. A stale launch flag also disabled Skip after setup began; the gate now permits Skip once claim/start has settled, verified before and after restart.

Root simplified template/setup copy to product language and retained original component ordering and board/side-panel layout.

## Original code and design mapping

| Desktop slice | Exact original sources at the pin |
| --- | --- |
| A/B templates | `apps/engine/src/agents/archive.ts`, `apps/engine/src/agents/import.ts`; `apps/ui/lib/templates/{capture,archives,install,install-template}.ts`; `apps/ui/components/dialogs/CreateTemplateDialog.tsx`; `apps/ui/components/templates/capture/{CaptureSelectStep,CaptureReviewStep,CaptureProgressPanel}.tsx`; `apps/ui/components/templates/{TemplateLibraryDialog,TemplateLibraryBrowser,TemplateDetailPanel}.tsx`; `packages/contracts/src/{agent-archive,template}.ts`. |
| C/D setup | `apps/engine/src/agents/setup.ts`; `apps/engine/src/tools/builtin/install.ts`; `apps/ui/hooks/useAgentSetup.ts`; `apps/ui/components/agent/{AgentPanelSetup,AgentSetupFields}.tsx`; `apps/ui/components/chat/{InstallGate,SetupEventCards}.tsx`; `packages/contracts/src/agent.ts`. |
| E/F app requests | `apps/engine/src/tools/builtin/hub.ts`; `packages/contracts/src/chat-hitl.ts` (`pendingServices`, `serializeServiceSetupResult`); `apps/ui/components/services/{ServiceSuggestionBlock,ServiceAlternatives}.tsx`; `apps/ui/components/chat/HitlReceipt.tsx`; `apps/ui/components/chat/AgentChat.tsx` service-request branch. Alternatives are not fabricated when the delivered request contains none. |
| G result cards | `apps/engine/src/tools/builtin/cards.ts`; `packages/contracts/src/chat-card.ts`; `apps/ui/components/chat/{FileCard,MediaAlbum,AttachmentTile,AttachmentLightbox}.tsx`; `apps/ui/lib/files/preview.ts`. |
| H composer | `apps/ui/components/chat/{ChatComposer,ChatAttachments,ChatAttachmentChip,AttachmentTile,AttachmentLightbox}.tsx`; `apps/ui/hooks/useFileUploads.ts`; `apps/ui/lib/chat/attachments-marker.ts`. |

## Root-run automated verification

Counts overlap; they are not a summed unique-test total. Engine source stayed unchanged through the later UI/server native fixes; the final affected server/client/component regressions were rerun.

| Check | Result and task-local evidence |
| --- | --- |
| Desktop component suite on final source | **119 files / 830 tests passed**, `work/round30-final-components.log`. This replaces the earlier history-fixture failure; the full component suite is green. |
| Desktop engine suite | **75 files / 653 passed**, `work/round30-engine-broad.log`. |
| Desktop server suite | **110 files / 798 passed; 15 files / 41 skipped**, `work/round30-server-broad2.log`. Skips are not passes. |
| Final template/setup/client/server/real-conversation cases | **15 files / 72 passed**, `work/round30-use-again-final-tests.log`. |
| Real finish/stream/Stop/Apps-close and tabs | **3 files / 13 passed**, `work/round30-tabs-services-recheck.log`. |
| Image/card regressions | **6 files / 35 passed**, `work/round30-media-recheck.log`; follow-up gate/original-display-name cases **2 files / 15 passed**, `work/round30-native-followup-regressions.log`. |
| Desktop shell | **26 passed**, `work/round30-shell-tests.log`. |
| Types | Engine and UI passed; `work/round30-engine-types3.log`, final `work/round30-use-again-final-types.log`. |
| Lint | Zero errors. Earlier broad modified-source check retained 145 warnings; final changed subset retained 9 warnings. `work/round30-ui-lint2.log`, `work/round30-use-again-final-lint.log`. Not warning-free. |
| Package and installed identity | Production build, bundled runtime and signing checks passed; `work/round30-accepted-package.log`, `work/round30-accepted-install.log`. |
| Saved-state and protected original comparison | Exact comparison passed; `work/round30-final-restart.log`, `work/round30-original-final.log`. |

## Native Mac and full-restart results

### Templates and setup

Captured **Round30 setup QA** from the disposable source coworker. Review selected `workspace/round26-note.md` and `skills/round27-checklist/SKILL.md` (156 bytes total), with instructions and the authored setup guide. Reopened the saved template, inspected it and installed a fresh coworker with zero chats, separate owner/engine IDs, selected files/skill and all desktop tool grants off.

First copy **Round30 Setup QA**: Install opened one Setup conversation and real Codex replied **SETUP30 READY**. Switching to the other chat showed Continue. After a full quit/reopen, Continue returned to the exact same introduction, session and kickoff record. Sending **Finish setup** invoked real `install_complete`, produced **Install complete** and **SETUP30 COMPLETE**, and unlocked ordinary chat. A separate normal chat replied **42**. Completion, both chats and all six messages survived restart.

Reopened the library in the final build: the prior installation appeared with its renamed coworker and **Use again**. Clicking it created a second independent coworker with zero chats. **Skip for now** allowed a normal chat and real Codex replied **43**. Set it up opened a single Setup chat and returned **SETUP30 READY**. Switching back to the normal chat and skipping the already-started setup worked. Renamed the copy **Round30 Skip QA**.

Full quit/reopen preserved the skipped banner, normal reply, two chats, same claimed setup and one kickoff. Set it up reopened the exact original setup messages without another session or run. Finish setup produced the real completion tool/card and **SETUP30 COMPLETE**. Another full quit/reopen retained the completed state and both independent chats. Final native reopening from the board showed **43** in the normal tab and **Install complete / SETUP30 COMPLETE** in Setup. Closing returned to the board.

Root's **Control Center → coworker Open → Install** additionally passed Save/reopen, exact owner selection, and Cancel/discard. `CANCEL30 MUST NOT SAVE` was discarded and did not change the guide. The Settings QA sibling opened its own unanswered setup fields, not the copied guide; its chats stayed unchanged.

### Suggested apps

Used real Codex `suggest_service` requests on the disposable source coworker. The ordered two-request flow retained its first decision and second pending card across full restart, including Needs you/Actions. Last Skip finished once, produced the saved Apps receipt and real **APP30 SKIPPED** follow-up; Stop halted the subsequent live response.

A fresh correctly identified **Microsoft Learn** request opened that exact app on that coworker. Closing Apps left the request pending. **Not now** produced one **APP30 NAV DONE** follow-up, retained an Apps 0/1 receipt and cleared attention. Pending and resolved receipts survived restart. This test did not connect an account or enable Apps. The temporary **Suggest apps** grant was restored off; the canonical desktop grant and Apps grant were checked. Positive connected-choice behavior has automated coverage; no new native OAuth/credential-provider connection is claimed.

### Image results and composer

Real Codex produced six own-file cards: GIF, WebP, AVIF, ICO, BMP and static SVG. Original four-preview-plus-more album and paged lightbox opened all six; after restart the same saved cards and later BMP/SVG pages reopened. Rendering was observed; precise GIF/WebP animation timing is not a new native claim here.

Uploaded still GIF, SVG, ICO and BMP together; the four-file cap refused a fifth AVIF. The unsent message and four image chips survived full restart. Sending produced correct real Codex image descriptions and **IMAGE30 VISION OK**. A mixed animated-GIF/unsafe-SVG/valid-AVIF batch kept the valid chip and showed failures for the other two with Send disabled. Removing the failed chips allowed the AVIF send; Codex identified the purple image and replied **AVIF30 OK**. Saved names/history persisted. The optimistic original-name correction has a streaming-to-history regression; the native saved names were also checked.

### Preservation and final state

The original **Settings QA: 21 chats / 64 messages** and **Codex connection check: 2 chats / 24 messages** match their protected baseline exactly, including identities and message contents. The existing QA sibling remains 4 chats / 25 messages. The disposable source copy has 14 chats / 73 messages after these live checks. Each new template copy has 2 chats / 6 messages. Their separate setup claims and completion timestamps persist.

The final full-restart comparison includes coworker/session rows, six tab layouts, 15 draft records, the existing unsent Apps navigation draft, Box/board state, template intents, setup state/kickoffs, setup instructions, grants and exact message contents. No unexpected change occurred across restart. The app is left on the board with Codex connected. QA fixtures remain clearly named for inspection; original coworkers were not deleted or reset.

## Limits and next work

- **W3 remains partial.** Capture currently supports confined UTF-8 text, instructions and user-owned skills: 1 MiB/file, 32 MiB/template, 200 files, 12 coworkers. Original binary/archive fidelity, full nonsecret configuration/environment/app requirements, hosted publishing/import and template deletion remain. Selected prose is copied as written; this is not a general privacy scrubber.
- **C3 remains partial:** broader model media inputs and full native drop/paste/progress/retry/cancel acceptance. **C6 remains partial:** generic private secret and remaining real sign-in flows. **C8 remains partial:** child/delegated runs and other tool/result presentations. **B5 remains partial:** Triggers and remaining contextual actions.
- Round31 A–H own persistent calls, original call UI, @mentions, isolated delegation, original delegation UI, app usage skills, browser exports and ordinary-run live preview. The extra agent owns local webhook/trigger source with public hosting explicitly unresolved. Root retains central integration and all fixes/tests/Mac acceptance. Assignment is not product acceptance.
- All A–H prompts now follow the user's requested larger full-list standard, preserving the existing worktree/base/ownership and the original Rerun design. Current work is not reset or implicitly redispatched.
