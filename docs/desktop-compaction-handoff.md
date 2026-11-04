# Desktop live compaction presentation

The desktop conversation now shows the original Rerun compaction row while the engine compacts a
long history. This is a presentation slice only: no threshold, context-budget, model-selection or
native Codex change is included.

## Original design

Reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/chat/CompactionBlock.tsx` — `CompactionData`, `CompactionStep`, `CompactionBlock`
  and their wording: `Compacting context…`, `Context compacted`, `Context compaction failed`.
- `apps/ui/components/chat/MessageView.tsx` — `data-compaction` classification and the folded
  `CompactionStep` row.
- `apps/engine/src/runtime/compaction/compact.ts` — the only producer of live compaction events.

`DesktopAssistantReply.tsx` reuses `CompactionStep` unchanged. It is the same one-line
`StepRow` the original chat folds into its step group, so the label, detail, icon, running shimmer
and failure colour are Rerun's, not a new desktop card.

## Live events supported

The engine writes one `running` event and then one settled event per checkpoint on the UI
message stream:

```text
{ type: 'data-compaction', id: <checkpoint id>, data: { status: 'running' } }
{ type: 'data-compaction', id: <same id>, data: { status: 'done', messagesCompacted, tokensRecovered } }
```

and, when summarising throws:

```text
{ type: 'data-compaction', id: <same id>, data: { status: 'error' } }
```

`lib/desktop/compaction.ts` validates those parts before they reach the row:

- `status` must be exactly `running`, `done` or `error`.
- `messagesCompacted` must be a finite, non-negative safe integer.
- `tokensRecovered` must be a finite, non-negative number.
- An invalid status drops the event. An invalid metric is omitted; the event keeps its real
  status and wording, with no count printed.
- The checkpoint `id` is the React key. A repeated id settles the first occurrence in place, so
  a received `done` or `error` event replaces the running row without a duplicate. The AI SDK
  already folds same-id data parts; this adapter also handles a replay or a direct stream fixture
  that carries both events.
- A `running` event seen when its reply is no longer streaming is suppressed. A stop or disconnect
  can lose the final event after the engine already saved a successful checkpoint, so there is no
  honest way to call it complete or failed. The original block has three states and no fourth
  "interrupted" label; suppressing the unconfirmed row avoids both a forever shimmer and a false
  failure. Its error wording is reserved for an error event the engine actually sent.

Parts without an id cannot be proven to be the same checkpoint, so each is drawn separately.
No other part type is interpreted here.

The existing stream path already carries these parts: the engine writes them to the run's
`UIMessageStreamWriter`, the desktop chat route returns the engine body unchanged, and `useChat`
keeps `data-compaction` parts (folding same type + id). No engine, route or conversation-projection
change was required for this slice.

## What history can honestly display

Nothing from this event. `compaction_checkpoints` stores the summary message and the
`throughMessageId` / `throughCreatedAt` cursor; it does not store the emitted
`data-compaction` status or counts. `transformEngineMessages` reads stored content, tool calls,
reasoning summaries and sources, and has no compaction branch, so a saved transcript contains no
compaction row. This lane deliberately adds none: a restart, a session switch or any reload that
reads saved history shows no compaction, rather than a fabricated date, count, token figure or
status.

Consequently the desktop row is a live-only row. It is visible while the turn streams (including
the completed state during the model's reply) and is not restored when the desktop replaces the
live transcript with saved history after the run, nor after an app restart. If persisted
compaction history is wanted later, it needs a real stored event first; it must not be inferred
from the checkpoint.

## Verification status

Authored, not executed by this lane (the integration owner runs all validation):

- `lib/desktop/compaction.test.ts` — status validation, finite/non-negative metrics, unconfirmed
  running suppression, in-place first-position update, duplicate suppression, id-less events, and
  a received error event surviving the end of its stream.
- `components/desktop/DesktopAssistantReply.test.tsx` — running → done wording and counts on one
  row, an interrupted running row leaving no row, a received error keeping the original failure
  wording, invalid metrics without invented counts, with reasoning, sources and feedback preserved
  alongside.

Not verified here: the Vitest runs, `tsc`, lint, a packaged Mac build, a real engine compaction of a
live history, and any Mac UI acceptance. The existing engine's `compact.test.ts` already covers the
two `data-compaction` writes; it was not executed in this lane. Browser/Electron sign-in, provider
credentials, packaging and the real workspace were not touched.
