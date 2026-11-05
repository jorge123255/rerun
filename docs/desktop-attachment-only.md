# Desktop attachment-only messages

Original Rerun `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` permits an empty textarea when files are selected (`ChatComposer.tsx`, `handleSubmit`). The hosted composer appends an attachment marker. Desktop keeps its validated structured attachments and now permits the same user interaction without inventing message text.

The composer waits for uploads and a saved draft, re-reads the current selection, and refuses a truly empty turn. Chat and queue validation accept empty text only with valid attachments. First-send and lost-response recovery titles use the selected file names. Receipt fingerprints still bind exact empty text, order and attachment identities.

The engine overrides text validation only for desktop requests. An exact read-only queued receipt probe may carry attachment identities without re-reading bytes; it exits through receipt lookup or a not-found/conflict response before any new run. New turns require resolved attachments, and hosted request validation is unchanged. Saved history/regeneration keep the original attachment parts.

Root completed native acceptance in installed `328ed48`: image-only draft restart/send, real visual recognition, text-only file send, visible queued attachment-only delivery, regeneration into an alternate chat and exact final-restart persistence. Root passed 118 UI/bridge tests, 37 engine chat tests, two compiled-engine lost-response/restart cases, type checks, packaging/runtime/signature verification and Mac checks. See `desktop-round28-attachment-only-acceptance.md` for evidence and limits.
