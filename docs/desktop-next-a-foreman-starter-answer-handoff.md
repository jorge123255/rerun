# A — Foreman starter text answer adapter (authority gated)

Base / parent: `7080add37a60bd604965649319143b8211818fd9`
Base tree: `e7db3a3f5df8057ffe86576153a8acff3360481b`
Branch: `desktop/next-a-foreman-starter-answer`
Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-a-foreman-starter-answer`
Both pins and clean status verified before editing. Final SHA/tree are supplied in the delivery response (this file belongs to that commit).

## Confirmed gap and original trace
Original reference: `c33c020ffb33263ec29de6f76d9b269bca786d90`.
- `apps/ui/components/foreman/ForemanColumn.tsx`: pending `show_starter_pack` keeps the composer; `sendOwn` answers its toolCallId with `{ answered: true, custom: text.trim() }`.
- `apps/ui/components/foreman/useForemanChat.ts`: `findPendingWidget`, `answerWidget`, answered-call guard, `addToolResult`; dismiss seals hub widgets without automatic resume, or stops engine interaction.
- `apps/ui/components/foreman/widgets/starter-pack/StarterPackWidget.tsx`: card choice produces `{answered:true,chosen}`; restored output is a verdict, including custom text.
- `apps/ui/lib/foreman/pending-widget.ts`, `seal-pending.ts`, `starter-pack.ts`: pending detection, typed answer/sealing and discriminated answers.

Mac mounted entry: `apps/ui/components/desktop/foreman/DesktopForemanColumn.tsx:93` sends through initial intake `sendOwn` or ordinary `foreman.sendMessage`; its empty-chat `DesktopStarterPack` opens local template review. `starter-pack/useDesktopStarterPack.ts` reads installable templates, not durable widget requests. The accepted welcome/intake authority is not a starter-widget answer authority. No production route, persistence or engine adapter for pending starter answers was found along this mounted path.

## Delivered source
- `apps/ui/components/desktop/foreman/starter-pack/starter-answer.ts`
- `apps/ui/components/desktop/foreman/starter-pack/starter-answer.test.ts`
- this handoff

Additive, intentionally unmounted adapter: explicit submit only; exact workspace/chat/request/revision; identical receipt recovery; local concurrent-submit guard; no retry after an ambiguous write; stale scope and mismatched receipts refuse. No ordinary chat fallback, template installation, engine reads, effects on rehydration or optimistic draft clearing.

## Exact missing prerequisite / root integration seam
Root must select and supply a trusted durable starter-request authority. Proposed ports are an adapter contract, not an existing backend protocol. Do not mount until root provides:
1. Authenticated read of the active pending starter request and revision in the active Foreman chat/workspace, including Stop/restoration/permission gates.
2. Atomic compare-and-set consuming that request for **all** text, card-choice and dismiss paths, with durable receipt persistence before any continuation; conflicts refuse, duplicates return the exact prior receipt. The server must recheck active identity, revision and Stop inside the transaction. A client lock alone is insufficient.
3. Receipt lookup across restart, including consumed requests; at most once continuation with explicit uncertain/reconciliation behavior. No auto-retry of an uncertain effect.

Instantiate `createStarterTextAnswerAdapter(readActive, ports)` once per composer lifetime. `readActive` returns null during Stop, restoration, blocking, or scope changes. For receipt recovery it must retain the exact submitted target until canonical reconciliation; do not repoint an old callback to a new request. At the existing `DesktopForemanColumn.send` seam, route only a trusted pending starter request to this adapter; leave welcome/intake and ordinary chat routing intact. Use the same composer and draft. Clear only on confirmed receipt AND unchanged draft/workspace/chat/request; otherwise preserve draft. Reconcile receipt to saved widget output for the existing restored verdict. Card choice and dismiss must go through the same durable authority; leave template review rail intact until the product mapping is decided. H owns saved reply actions/regenerate; Grok owns engine reads. No shared root mount edited here.

## Authored regressions / remaining gates
Offline Vitest source covers unavailable authority and effect-free construction, exact request/trimmed payload, receipt recovery, wrong workspace/chat/revision and Stop, supersession during read, concurrent submit, ambiguous-write no-retry and mismatched/conflicting receipts. These are adapter fixtures, not proof of server durability or cross-window CAS. Root must add backend transactional tests for text-v-card-v-dismiss races, restart duplicate recovery and permission loss once authority exists.

All tests, typecheck, lint, build, install and Mac QA remain UNRUN. Installed Next documentation is absent; this pure TypeScript adapter adds no Next API or routing. No accounts/providers, app launches, VM changes, push, PR or merge.

Root board/restart procedure after authority integration: open a pending starter request from board, type through the existing composer and verify one durable custom answer and recap; choose a card in a separate fixture; dismiss in another. Keep a draft during Stop, stale/superseded request and workspace/chat switches; delayed acknowledgements must not clear it. Race card and text in two views, confirm one receipt/continuation. Simulate lost acknowledgement, reopen and cold restart; recover exact receipt without resubmission. Reopen restored recap and verify no action/network caused by rendering. Source delivery is authority gated and is not Mac acceptance.
