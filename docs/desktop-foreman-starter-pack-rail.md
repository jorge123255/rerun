# Desktop Foreman starter-pack rail (UI10/E11)

Source for the Foreman's starter-pack choice rail, filled from this workspace's own templates.

**Not executed.** No test, type check, lint, build, packaging or app launch ran in this lane. The
regression below is authored and left unrun; root runs the gates and Mac QA.

## Pin and original design

- Repository `jorge123255/rerun`, base **8d08f87b482dd30fe179cb8b17f99e3f23313898**, tree
  **41b07b00b13894af36a7a9716eba95e39490e9f3**, verified before editing and reproduced by the
  worktree (`git rev-parse HEAD` and `HEAD^{tree}`).
- Original design `rerun-build/rerun` **ab3def9bfcf545cc9548f99c63c2b011ca094023** (dev tip,
  2026-11-06), the only place the starter pack exists: it is written by the hosted onboarding
  script as a `show_starter_pack` chat widget.
- Reused unchanged:
  - `apps/ui/components/foreman/widgets/starter-pack/StarterPackWidget.tsx` and
    `StarterPackRail.tsx` (the rail itself, card sizing, snap and scroll behaviour);
  - `apps/ui/components/foreman/widgets/renderForemanWidget.tsx` (the hosted widget switch; this
    lane does not change it);
  - `StarterPackCard.tsx`, `useStarterPicks.ts`, `lib/foreman/starter-pack.ts`;
  - delivered Mac code: `apps/ui/lib/desktop/templates-client.ts`,
    `apps/ui/components/desktop/templates/DesktopTemplateNavigation.tsx` and
    `DesktopTemplateLibraryDialog.tsx` (its `requestedTemplate` opens a template's review).

## What was missing, and why the rail was mounted here

The Mac Foreman never renders hosted tool widgets: `DesktopForemanChatLayer` draws messages, docs
tool parts and the plan card, and has no `renderForemanWidget`. The hosted starter pack is written
by `lib/foreman/scripted.ts`, which this build does not use, so the widget and its rail existed in
source with nothing to mount them.

The rail therefore mounts where the widget would have appeared in the hosted transcript: inside
the Foreman conversation, above the composer, when the conversation is empty and no plan or build
is showing. It reads local templates, not a hosted library.

## Files

| File | Role |
|---|---|
| `apps/ui/components/desktop/foreman/starter-pack/starter-pack.ts` | Availability filter and card mapping (pure) |
| `.../starter-pack/useDesktopStarterPack.ts` | Local template list, abort on workspace change, retry |
| `.../starter-pack/DesktopStarterPack.tsx` | The rail mount, single pick, review hand-off, states |
| `.../starter-pack/index.ts` | Barrel |
| `.../starter-pack/DesktopStarterPack.test.tsx` | Authored regression (unrun) |

Three additive seams:

- `DesktopForemanColumn.tsx`: optional `onReviewTemplate`, and the mount passed as the chat layer's
  existing `children` when the conversation is empty (`foreman.restored && messages.length === 0 &&
  !plan.view && !foreman.build`).
- `DesktopForemanPanel.tsx`: forwards `onReviewTemplate`.
- `DesktopApp.tsx`: `reviewTemplate(template)` sets `templateToReview` and opens
  `DesktopTemplateNavigation` — the same seam `reviewTemplatePlacement` already uses — behind the
  existing creation-admission, workspace-dialog and quitting guards.

## Behaviour

- **Genuinely available only.** `availableStarterTemplates` drops a draft (`'Draft — not captured'`),
  a template without a revision, one with no coworker to land and a duplicate id, so no card can
  offer an install that would immediately refuse.
- **A choice enters review, it does not create.** Picking selects; Review passes
  `{ templateId, revision }` to root, which opens the template library on that template's detail.
  Coworker creation stays behind the library's own install confirmation and placement. This
  component never calls `install`.
- **Manual intake preserved.** The intake screen is untouched; the rail lives in the conversation.
- **Plan review preserved.** The rail hides as soon as a plan card or build progress exists.
- **Duplicate presses.** One latch per selection: the second click of a press that is opening the
  review is ignored, and the latch clears when the selection changes, the workspace changes or the
  panel closes.
- **Workspace change.** The hook keys on `workspaceId`, drops the previous cards and selection, and
  discards any list answer that arrives after the change (generation counter), so one workspace's
  templates never appear as another's.
- **Honest states.** Loading is a skeleton; a failed list is an alert with Try again; no genuinely
  available template renders nothing at all rather than an empty rail or a dead button.

## Authored regression (unrun)

`DesktopStarterPack.test.tsx` mocks the shared rail and drives a fake template client:

1. only installable templates reach the rail (draft, empty and duplicate rows dropped);
2. picking enables Review, one click opens it once with the exact identity, a double press calls
   back once, and nothing installs;
3. a new `workspaceId` reloads, drops the pick and the pressed state;
4. an empty library renders nothing, and a failed list shows its message with a working Try again.

## Remaining gates

- Root: type check, lint, the UI suite, build and packaging.
- Mac QA: the rail in the docked and floating Foreman, narrow and wide columns, a workspace switch
  while it loads, and the review → install → placement path end to end.
- Hosted discovery, onboarding (lane C) and core tool dispatch are out of scope here; the hosted
  `show_starter_pack` widget itself is unchanged and still unrendered by the Mac chat layer.
