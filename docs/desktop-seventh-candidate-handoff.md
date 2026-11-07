# Seventh candidate handoff

Source repair of the two PR12 failures. No install, typecheck, lint, test, build, or runtime was run here. These changes are source-addressed and still UNRUN. PR12 results stay attached to `8b111db65a2af119b3fb26a304adaa510f98de8b` only.

## Pins

| Tree | SHA |
|---|---|
| PR12 parent | `8b111db65a2af119b3fb26a304adaa510f98de8b` |
| PR11 | `d4a8d22c089328fd1bf7fc62008b5e91c4513713` unchanged |

Evidence archive SHA256 `b1d9c74a6aea61c64e411533fe4712cec51455607da3af8f81748bc9e2062bf7`. PR12 builds, both typechecks, eslint (0 errors, 993 warnings), UI focused 28/28, and packaging 13/13 passed on that SHA. They were not rerun here.

## Failure to cause to repair

| Log | Cause | Repair | Rerun |
|---|---|---|---|
| Engine focused: 4 private-search failures, all `Use a relative directory in this coworker’s workspace.` The home path is no longer in the log | The tests call `execute` directly. The tool schema’s default path `.` is not applied, so `path` is `undefined`. `desktopPrivateSearchPathAllowed` rejects that. The cancelled-pattern test only required some rejection, so it did not catch the same miss | The fixture supplies `.` when the caller omits path, which is the schema default and a relative workspace directory. Absolute `/tmp/outside` and `../outside` must still throw the relative-directory error. The temp root and the not-`~/.rerun` checks stay | UNRUN |
| Isolation fixtures 0/2: `SyntaxError: Unexpected token 'throw'` at `contract.mjs:59` | The identity `if` is missing the `)` before `throw`, so neither Node test file can load | The parenthesis is restored. The positive profile now uses `realpathSync(tmpdir())` instead of a hard-coded `/private/tmp`. The isolation fixture realpath’s its temp parent before creating a profile, so a symlinked temp directory is not presented as a fresh path. Linked-path refusal stays | UNRUN |

## Still closed

Named selection stays 503. Foreman file grants stay default false. Packet 6 is not startup. Packet 7 is not a policy. Selected vision does not substitute another model. Full suites, the desktop listener glob, and native smoke stay blocked. A HOME override is not isolation proof.
