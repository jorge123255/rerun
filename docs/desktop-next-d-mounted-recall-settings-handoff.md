# D — Mounted Settings-to-board recall

Branch `desktop/next-d-mounted-recall-settings`. Parent pin `89ec2070571c7d0d588e8e10d3e1a860681d05a5`, tree `487a0d7194a6dd0375c543e9b68f8136508d4bb8` (draft PR #25). Remote finish `desktop/finish-cloud-base-20261106-8297fe64` remains merged PR #24 `d518abdbfd38985ab4c185950c22e36b1b90a269`.

No production change. The passed loopback fixture calls the engine and the auxiliary store directly. It does not mount Settings or the memories panel. This round adds `apps/ui/components/desktop/DesktopMountedRecallSettings.acceptance.test.tsx` only.

The fixture mounts `DesktopSettings` on Tool services (`workspaceId` 7, the same screen prop; the API-connections panel stays on the other tab), `DesktopCoworkerMemories`, and `DesktopBrainSidebar` plus the canonical Care sentence. Saving the key goes through `PATCH /api/desktop/auxiliary`. Recall goes through `/api/desktop/coworkers/:id/semantic-memory`, the real runtime authority, and the engine semantic routes. The OpenRouter embeddings URL is mapped to `127.0.0.1` only inside this file. Every other external origin throws. Search and transcription stay unconfigured. The Brain grant starts on for this coworker and is revoked at the end.

Company Brain’s mounted search matches page title and slug only. “Dogs” shows “No page matches” while the Care sentence stays on the page. Semantic brain ranking stays on `desktopBrainSemanticIndex` because the panel does not call it. After Remove key, retry does not call the provider. After the Brain grant is revoked, search throws and does not call the provider. The plaintext synthetic key is absent from sqlite. Wrong session is 401. A coworker row outside local workspace 1 is 404. Foreign engine configuration is 400.

Runtime `workspaceId` 7 still uses local `desktop_agents.workspace_id` 1. That hardcode is unchanged. `findDesktopAgent` needs `desktop_space_placements` present.

Root runs this file, then the same disposable board: Tool services, save only Memory search, paraphrase “Dogs need regular walks” against “Canines require daily exercise”, cold reopen without a provider call on open, offline keyword fallback, Remove key, clear the note, revoke Brain. Quit/reopen of the installed app, live accounts, and OS permissions stay root QA. This lane did not run the test, build, push, or launch the app.

Original `c33c020ffb33263ec29de6f76d9b269bca786d90`: `AgentPanelMemories.tsx` recall count, `services.service.ts` keyword fallback when no embedding key, `lib/services/embed.ts` OpenRouter `text-embedding-3-small`, `brain/embedding.ts` keyword until a vector exists, `BrainSidebar.tsx` page search. Desktop already maps the key to Tool services → Memory search.
