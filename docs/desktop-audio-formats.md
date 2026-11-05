# Desktop file audio formats: M4A, Ogg, FLAC (lane handoff)

Branch `desktop/round28-audio-formats`, base `15dce4a9dcefeb95b0042d01d8b2afc9bbe5c3f6`. Source only. The integration owner runs tests, typecheck, lint, build, packaging, installs, live requests, and Mac/restart QA, including real M4A, Ogg, and FLAC playback. This handoff does not claim those results.

## Upstream

The original Rerun pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` has no `FileAudioPreview.tsx`; its audio preview is `apps/ui/components/files/FilePreview.tsx` (`kind === 'audio'` → `<audio controls src={rawUrl} className="w-full max-w-md">`) gated by `apps/ui/lib/files/preview.ts` (`AUDIO_EXTS = mp3, wav, ogg, m4a, flac`). The desktop adapter already reproduces that design (header + back, sibling controls, centered `<audio controls>`, skeleton, error line). This lane only widens the accepted set; no layout change.

Mac adaptation: playback stays in the browser `<audio>` element fed by a blob URL, exactly like WAV/MP3. No native decoder, no conversion, no new dependency. Content types emitted are the registered ones (`audio/mp4`, `audio/ogg`, `audio/flac`); `x-content-type-options: nosniff` and the blob type let the browser sniff the container itself.

## Changed files

- `apps/ui/lib/desktop/server/audio-bytes.ts` — `DesktopAudioKind`/`DesktopAudioContentType` widened to `wav | mp3 | m4a | ogg | flac`; `desktopAudioKind` maps the same five extensions as `preview.ts`; `inspectDesktopAudioBytes` dispatches to three new structural readers. WAV and MP3 readers are byte-for-byte unchanged.
- `apps/ui/lib/desktop/server/audio-bytes.test.ts` — authored, not run. Adds extension mapping plus self-contained M4A/Ogg/FLAC fixtures and negative cases.
- `apps/ui/components/desktop/DesktopFileAudioPreview.tsx` — `isDesktopAudioName` now delegates to `desktopAudioKind` (single source for the extension set); `AUDIO_TYPES` accepts the three new media types. Controls, seek/volume (native `<audio controls>`), sibling navigation, route-shape guard, and error paths are unchanged.
- `apps/ui/app/api/desktop/agents/[agentId]/files/audio/route.ts` — doc comment only; the handler already returns `audio.contentType` from the inspector, so new types flow through unchanged. Range support stays absent by design (blob-URL preview, per the existing route comment).

Not changed: `coworker-files.ts`, `DesktopCoworkerFiles.tsx`, `image-bytes.ts`, contracts, chat cards (`isDesktopCardAudio` keeps its own WAV/MP3 contract — widening it is root's later review), `DesktopApp.tsx`, `DesktopBoard.tsx`, `DesktopConversation.tsx`, packaging.

## Validation semantics

`audio-bytes.ts` throws `DesktopAudioBytesError` with `reason` ∈ `mismatch | corrupt | unsupported`; `readAudio` in `coworker-files.ts` already maps these to 415 "not a supported audio file" / "format can't be previewed" / "damaged". Extension alone never admits a file — every kind requires container proof:

- **M4A** (`readM4a`): box walk (32/64-bit sizes, size-0 tail box). First box must be `ftyp` with an audio-capable major brand (`M4A `, `M4B `, `mp42`, `mp41`, `isom`, `iso2`, `iso5`, `iso6`). `moov` must contain an `stsd` sample entry `mp4a` (AAC) somewhere in the track tree. Other browser-playable-in-MP4 audio fourccs (`alac`, `ac-3`, `ec-3`, `Opus`, `fLaC`, `dtsc`, `dtsh`, `dtse`) → `unsupported`; video-only or foreign containers → `mismatch`; malformed boxes → `corrupt`.
- **Ogg** (`readOgg`): every page must have `OggS`, version 0, reserved header bits clear, in-bounds segment table, and a valid Ogg CRC-32 (poly `0x04c11db7`, MSB-first, zeroed check field). First page must be BOS; its first packet is the codec ident: `\x01vorbis` (version 0, sane channels/rate, framing byte), `OpusHead` (version 1, 1–255 channels), `fLaC` or `0x7fFLAC` (FLAC-in-Ogg). Anything else (Speex, Theora, CMML, unknown) → `unsupported`. Pages must consume the file exactly.
- **FLAC** (`readFlac`): `fLaC` marker, metadata blocks walked to the last-block flag with STREAMINFO first (blocksize/frame-size bounds, sample rate 1–655350, 1–8 channels, 4–32 bit → else `unsupported`), then the first audio frame header must parse: 14-bit sync, reserved bits clear, valid blocksize/samplerate/channel/bps codes, UTF-8-style coded number, trailing blocksize/samplerate bytes, and a valid CRC-8 (poly `0x07`). Sample decode stays in the browser, same as WAV/MP3.

`DESKTOP_AUDIO_MAX_BYTES` (16 MB) and all reader limits are unchanged.

## Root integration fragment (required)

`apps/ui/lib/desktop/server/coworker-files.ts`, in `readAudio`, the kind gate message is now stale. Everything else in that function already flows through `desktopAudioKind`/`inspectDesktopAudioBytes` and needs no change:

```ts
// before
if (!kind) throw new DesktopHttpError(415, 'Only WAV and MP3 files can be previewed.')
// after
if (!kind) throw new DesktopHttpError(415, 'Only WAV, MP3, M4A, Ogg, and FLAC files can be previewed.')
```

`DesktopCoworkerFiles.tsx` needs no change: `isDesktopAudioName(entry.name)` picks up the new extensions automatically. No dispatch, prop, or contract change.

## Remaining limits

- M4A accepts AAC (`mp4a`) only; ALAC/AC-3/E-AC-3/Opus/FLAC-in-MP4/DTS report `unsupported` rather than risking a browser that cannot decode them. If root wants ALAC, Safari-only playback would need an explicit product decision.
- Ogg accepts Vorbis, Opus, and FLAC payloads; Speex/Theora/other codecs report `unsupported`. Only the first logical stream's ident is checked; chained Ogg is walked structurally and the browser plays what it can.
- FLAC validates metadata plus the first frame header (sync, codes, CRC-8); later frames are not walked — same trust boundary as WAV/MP3 where the browser does sample decode.
- `.oga`, `.opus`, `.m4b` extensions are not admitted (original `AUDIO_EXTS` parity).
- The authenticated route still returns the whole file with no byte ranges, per the existing design; seeking stays inside the blob URL.
- Chat-card audio (`isDesktopCardAudio`, `DesktopFileLightbox`) is untouched per lane scope.

## Dependencies

None added. `sharp` is not used; all checks are hand-rolled byte parsing like the existing WAV/MP3 readers.
