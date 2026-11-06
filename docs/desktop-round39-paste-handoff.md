# RD39 E3 non-Latin guest paste handoff

**Kind:** narrow source repair — **not** RD39 complete, **not** accepted, **not** tested.  
**Branch:** `desktop/round38-master-completion`  
**Worktree:** `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round38-master-completion`  
**Frozen base:** `6f6ad959a09abaf1947950b6f82413c94407e22a`  
**Original pin:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (`apps/ui/components/desktop/DesktopViewer.tsx` paste always `clipboardPasteFrom`+Ctrl+V; `type`/`keysymOf` already Unicode-capable)  
**Impl SHA:** `08b3a68902a99a7f399539b17e4414d59848f885`  
**Parent tip before this commit:** `ddbcd349017f42665d0760f58721cc23e40940e9`

## Change

| Path | Role |
|---|---|
| `apps/ui/components/desktop/guest-paste.ts` | Pure mode decision + code-point unit helper |
| `apps/ui/components/desktop/guest-paste.test.ts` | Authored **unrun** regressions |
| `apps/ui/components/desktop/DesktopViewer.tsx` | `paste` handler only: if any code point >U+00FF, type full string via existing `keysymOf` loop; else keep clipboard+Ctrl+V |

## Behavior

- Latin-1 (incl. `café` / U+00E9) and newlines → unchanged `clipboardPasteFrom` + Control+V.
- Any code point >U+00FF (kana, CJK, astral) → **only** Unicode keysym typing for the **entire** string (no dual clipboard+type).
- Astral: `for…of` / `guestTypeUnits` iterate by code point; `keysymOf` uses `codePointAt(0)`.
- Does **not** enable extended clipboard (`0xc0a1e5ce` remains stripped in `rfb-input.ts`).
- No host `navigator.clipboard` fallback; no renderer layout / IPC / tool registry edits.

## Unrun regressions (not executed)

Latin-1 stays clipboard; kana/CJK/astral/mixed → `unicode-type`; astral one unit; modes mutually exclusive.

## Root fragments

None required for this repair — no new port binding. Guest takeover/Stop/permission gating unchanged outside this handler.

## Unsupported / risks

- Guest apps that only accept clipboard paste (not key events) still will not receive >U+00FF via this path; that is the existing `type` limitation.
- Very long Unicode pastes become many key events (same as `type`).
- No guest/Docker operated this checkpoint.

## Proposed PR text

`fix(desktop): type non-Latin guest paste via Unicode keysyms`

When DesktopViewer paste includes any code point above U+00FF, send the full string through the existing Unicode keysym path instead of Latin-1 ClientCutText + Ctrl+V. Keep Latin-1 on the clipboard path. Do not enable extended clipboard.

## Status

SOURCE-REPAIRED · INTEGRATION-PENDING (root native guest verify) · ROOT-UNVERIFIED · tests not run · no push/PR · checklist not mutated
