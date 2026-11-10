# D — Configured semantic recall acceptance fixture
Base/parent: 7080add37a60bd604965649319143b8211818fd9
Base tree: e7db3a3f5df8057ffe86576153a8acff3360481b
Branch: desktop/next-d-semantic-recall-fixture
Worktree: /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-d-semantic-recall-fixture

Original reference c33c020ffb33263ec29de6f76d9b269bca786d90:
apps/engine/src/memory/embed.ts, memory/store.ts (query embedding, vector/FTS fusion and rank floor);
apps/engine/src/brain/embedding.ts (hash-guarded publication and deferred retry).

Mac trace:
apps/engine/src/desktop/semantic-memory/runtime.ts -> internal semantic-memory configuration/embed -> service.ts -> index-store.ts/recall.ts.
apps/ui/lib/desktop/server/semantic-memory/embedding.ts authenticates engine, exact owner and configuration revision; server/auxiliary/store.ts and backends.ts supply the existing embedding-purpose tool-service configuration. No alternate provider is selected here.
apps/engine/src/desktop/brain-semantic/runtime.ts uses the same internal callback with engineAgentId/revision and Brain store/pages.
apps/engine/src/tools/registry.ts desktop branch selects desktopMemoryTools and desktopBrainSemanticTools; memory-tools.ts and brain-semantic/tool.ts retain grant checks. Existing memory-tools.semantic.test.ts and brain-semantic/tool.test.ts cover model-tool forwarding/authority; this packet does not replace or bypass those checks.

Changed source:
- apps/engine/src/desktop/semantic-memory/configured-recall.acceptance.test.ts
- apps/engine/src/desktop/brain-semantic/configured-recall.acceptance.test.ts
- apps/engine/src/desktop/semantic-memory/runtime.test.ts
- this handoff

Fixtures use an explicit synthetic vector oracle mapping “Canines require daily exercise” and “Dogs need regular walks” to the same vector, with an orthogonal billing distractor. The pair shares no words. This demonstrates configured seam/ranking behavior, not a live embedding model's semantic quality. Runtime fixture uses real runtime and internal callback port; service fixture reopens the file index from a disposable directory after shutdown. Provider unconfigured/offline/changed conditions separate keyword fallback from semantic retrieval. Owner and delayed clear/drain fixtures guard against cross-owner results and stale publication. Brain fixture recreates service over retained store ports, tests unavailable/changed configuration and removed pages; it is not a process/SQLite restart test. Existing Brain service tests cover rotated credentials and delayed cancellation.

No production defect was demonstrated by executed evidence, so no production source changed. No new provider support or root wiring needed. Root must execute authored and existing lifecycle/tool suites, then run a configured real provider acceptance in the sandbox app, both memories and Brain. Verify meaningful paraphrase against distractors, distinguish fallback visibly, repeat after cold restart and after provider disable/change, test sibling owner, and clear while indexing is delayed. Actual provider quality, full tool-service UI selection, SQLite/process restart and installed Mac behavior remain acceptance gates.
All tests, builds and Mac QA UNRUN. No accounts, providers, install, push, PR, VM or permission changes.
