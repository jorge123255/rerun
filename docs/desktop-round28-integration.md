# Round 28 combined integration

Original design/reference: Rerun `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. Root combines the independent source handoffs below in `desktop/m1`; the user-owned agent worktrees are retained unchanged. All execution checks and Mac acceptance are root-owned.

| Lane | Final source handoff | Scope |
| --- | --- | --- |
| A | `be36fe6b11f466e8e4b13ba685325b9b749e6e36` | animated-images |
| B | `8f631f2617589910442c012b67b8428838a40116` | audio-formats |
| C | `e31d6e0c0bab7b5b69c3dcea08c521235e868683` | video-formats |
| D | `d7185144336f59088f6028712d59910b27f17d4a` | brain-proposals |
| E | `102a2210c5cb90c09c4f08509e2a3b60b97dfa85` | native-writeback |
| F | `ea1cb30927f535006ea917392a9ca14573f70ebc` | mcp-stdio |
| G | `5a3edf5d1acbefb1ad4cdc86e73f6364d042fd94` | brain-pages |
| H | `abaf89ae4297d248c425c8c552218f5b04b65dd6` | brain-ui |

## Review corrections

- One engine-owned Company Brain store, shared by page routes, proposal decisions and coworker read/search/propose tools. Atomic proposal fingerprint/page-hash checks and durable receipts/publication recovery replace the original force-write path. Local keyword search avoids hosted embedding dependencies.
- Brain drafts and mutation identities live in authenticated app storage so a changed local port cannot erase them. Save success persists the new page hash before clearing its receipt identity. Cleared draft metadata retains stale-write protection without consuming active draft capacity.
- Company Brain uses the original editor/sidebar/history/proposal components. Its modal excludes hidden-chat read acknowledgement and blocks competing board/model-settings navigation.
- Local MCP subprocess tools use bounded Zod schemas so real configured adapters reach Codex; copied adapters still fail the authenticity filter. A distinct grant, exact current run/config admission, durable call identity and process cleanup remain required.
- Native text writeback captures only after the writer stops, binds original file/directory identities, and publishes only exact reviewed bytes. Cancelled-run captures are non-actionable and Apply rechecks cancellation. Unknown acknowledgements never trigger another publication automatically.
- Shutdown confirms both local MCP groups and native writers stopped; a failed drain cancels Quit and a successful retry clears the earlier failure.
- Native QA found the bundled Next server exits 143 after graceful SIGTERM cleanup. The shell now recognizes only that requested UI exit after an authenticated tool drain, while retaining failed engine exits after a stop timeout so retry cannot forget them.
- Animated previews retain frame/canvas/byte limits without widening composer/logo inputs. Audio container inspection preserves the byte buffer and validates complete Ogg sequences. WebM element-size and block integer rules are distinct; valid lacing no longer fails.

B and C finished after the first combined source pass. Root reconciled their final commits rather than replacing already corrected readers. B's final production source was already represented. C's preview UI tests were retained; its alternate reader would weaken the combined bounded validation. See `desktop-round28-media-integration.md`.

## Acceptance boundary

Final packaging and native acceptance passed in installed product `06ebdf6`; see [round 28 acceptance](desktop-round28-acceptance.md). All eight handoffs are accepted alongside root's earlier attachment-only slice. D8 is complete; 24 checklist groups remain. Local programs run with Mac-user access, not an OS sandbox. No custom subprocess environment, remote OAuth sign-in, legacy SSE, hosted semantic embeddings, or general binary writeback is claimed.
