# Round 28 Files media integration — source handoff

Root reconciled the final A `be36fe6`, B `8f631f2` and C `e31d6e0` handoffs. A was imported and corrected; B's source was adapted before its final commit and that final commit adds no missed production fix. C finished after the first integration pass. Its alternate parser does not replace the stricter combined reader; its preview-control tests are retained with the deliberate MP4 MIME for M4V. Root owns all execution and native acceptance.

Original design/source: `a6d63a4` `apps/ui/components/files/FilePreview.tsx`, `FileDetail.tsx`, and `apps/ui/lib/files/preview.ts`. The existing Mac preview header, sibling controls, image frame and user-started audio/video controls remain. Authenticated owned-file routes return bounded bytes to a blob URL; no hosted URLs, external resources, transcodes, codec downloads or new dependencies.

Animated images use a preview-only reader bound to the existing file recovery/claims. Composer snapshots, logos and result-card inputs retain static restrictions. WebP trailing EXIF/XMP is admitted; frame/canvas/aggregate limits remain.

Audio adds M4A (version-zero AAC sample entries), Ogg audio and FLAC. M4A inspects a bounded fixed track hierarchy, rejects video handlers, and requires media data. Ogg checks checksums without modifying Buffer input, stream serials, page sequences, packet continuation and end markers. FLAC accepts the valid 32768-sample block-size code. Codecs or samples the browser cannot decode produce the existing visible player error. This is container admission, not a playback claim.

Video adds WebM, MOV and M4V. MOV accepts QuickTime or ISO movie brands, including legacy movies without ftyp; MP4/M4V retain their original brand restrictions. WebM parses bounded EBML metadata, video track identities/dimensions, VP8/VP9/AV1 codec identifiers and block/lacing envelopes, with finite or streaming-size Segment/Cluster containers. The 16 MiB cap remains. Decoder compatibility is confirmed only by root's playback checks. Both readers keep the existing complete-file blob seek behavior (there was no HTTP range implementation to preserve).

`DesktopCoworkerFiles` already dispatches through the leaf name predicates, so it needs no source edit. Common `coworker-files.ts` now binds animated-image recovery and updates supported-format messages. Card contracts and card MIME admission remain unchanged.

Focused source tests authored: `audio-formats.test.ts`, appended `video-bytes.test.ts` and `animated-image.test.ts` regressions, and corrected video route expectations. Root should run these together with existing audio/image/video route suites and Files navigation/cleanup suites, then inspect real animated GIF/WebP, AAC M4A, Ogg, FLAC, WebM/MOV/M4V playback, close/previous/next cleanup and restart behavior.

Review correction: WebM block track/lacing integers accept all-one data values without treating them as unknown element sizes. Element-size unknown markers remain restricted to Segment/Cluster; zero, unsafe and truncated data integers remain refused.
