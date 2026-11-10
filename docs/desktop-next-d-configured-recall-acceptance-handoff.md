# D — Normal configured recall through disposable loopback embeddings
Base/parent d518abdbfd38985ab4c185950c22e36b1b90a269; tree 94f7b0220733175e86c022befcd592752303be82.
Branch desktop/next-d-configured-recall-acceptance.
Worktree /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-d-configured-recall-acceptance.
Exact clean pins verified before editing.

Authored apps/ui/lib/desktop/server/semantic-memory/configured-loopback.acceptance.test.ts plus this handoff. No production change. A suspected workspace hardcode was NOT changed: runtime.ts documents that per-workspace app databases retain local row 1; readDesktopRuntime confines the selected dataRoot/engineRoot/install+workspace marker, and openDesktopDatabase opens that selected app.db. Replacing local row 1 with runtime workspace number would break this convention.

Fixture joins real normal paths:
encrypted desktopAuxiliaryStore embedding-purpose change -> desktopAuxiliaryBackends fixed existing provider/model/dimensions -> authenticated internal semantic-memory POST -> engine desktopInternalJson -> semantic-memory/runtime and brain-semantic/runtime -> file semantic index and real SQLite Brain semantic store.
No new endpoint/provider support or production configuration flag. Test-only fetch transport maps the existing fixed OpenRouter embeddings URL to an ephemeral 127.0.0.1 HTTP fixture and rejects all other external targets. Synthetic key only. Internal engine callback also goes over the same loopback server and retains actual Bearer/Host authentication. Runtime/database and canonical note/Brain page ports are disposable fixture adapters; no live app DB, account or real credential is read.

Oracle maps “Canines require daily exercise” and “Dogs need regular walks” to matching 1536-dimensional synthetic vectors. They share no words. Saved note and Brain passage appear via semantic search; provider 503 makes the paraphrase absent while literal “Canines” remains through keyword fallback. This proves configured wiring/ranking separation, not a model's real semantic quality.
Fixture closes/reopens SQLite stores and reloads engine runtime modules, recovers indexes and configured key; foreign DB-local owner scope refuses. Clearing embedding configuration uses the existing CAS revision; canonical memory-clear callback drains derived records and yields no old note; revoked Brain grant refuses. Synthetic key remains encrypted in stored settings. No external embedding traffic is permitted by the test adapter.

Root runs this authored test, existing auxiliary/embedding/runtime/tool and Brain lifecycle suites, then the same disposable scenario in sandbox app from Tool services and board. Note and Brain keyword-free queries must differ visibly from fallback; cold restart retains exact configured service and current owner; disable provider/clear note/revoke Brain and inspect no stale results or republished vectors. Physical process restart, full workspace selection/owner marker validation and installed UI remain root QA gates; fixture readDesktopRuntime/openDesktopDatabase are scoped test ports.
Original c33c020ffb33263ec29de6f76d9b269bca786d90: engine memory/embed.ts, memory/store.ts and brain/embedding.ts establish configured embedding plus keyword fallback and guarded publication.
All test execution/builds/Mac QA UNRUN. Loopback listener is authored test source only, not started in this lane. No live service/account, provider traffic, new brand, push, installation or native/VM/permission changes.
