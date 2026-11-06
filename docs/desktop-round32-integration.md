# Round32 root integration checkpoint

Root reviewed and integrated all A-I handoffs against original Rerun a6d63a4b542674ddd002e51b39ba0df6e0807bcc. This is source integration, not Mac acceptance.

The integration supplies concrete local authorities for semantic recall, retained voice drafts and chat dispatch, secret requests, bounded web search, isolated guest launchers, additional App accounts and SSE, reviewed self-MCP proposals, and portable local templates. Provider auxiliary credentials are encrypted separately from ChatGPT login. Existing original board, chat, Apps, approval and template components remain the design references.

Root fixes include immutable receipts and SQLite serialization; fresh owner/grant/run fences; voice first-tab scope and model recovery; bounded audio reads; source-bound secret and MCP reviews; launcher cancellation/input draining; no-replay template imports; and current enabled/model checks before regeneration. The isolated guest image uses a new round32 tag, leaving the accepted round29 image intact.

Numbered UI migrations 10-17 and engine data-dir step 5 are additive. Previous shipped steps remain intact. Native microphone access is restricted to audio from the current trusted desktop main frame. Native template dialogs expose opaque handles, not caller-chosen paths.

## Root checks at checkpoint

- UI and engine TypeScript checks passed. Modified UI lint has zero errors (existing warnings remain).
- Native shell suite: 31 passed. Guest Python suite: 27 passed. New guest image built successfully.
- Focused voice/Control Center suite: 70 passed. Other focused sources and migration checks were run by root; logs are in the root task work folder.
- Final full suites and signed packaging are still in progress at this checkpoint. Their final outcomes and real Mac/restart acceptance must be recorded separately.

Live semantic embeddings, speech transcription and Brave search require their configured auxiliary provider credentials. An unavailable connection is not a successful live test. The installed accepted preview remains 40aa370 until the candidate has passed packaging and installation checks.

Round33 A-I have also been reviewed read-only. Their fixes and concrete bindings belong to the next integration checkpoint. Round34 A-I worktrees/prompts are prepared; agents do not execute tests or operate the app.
