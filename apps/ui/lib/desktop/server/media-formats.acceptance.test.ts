import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { inspectDesktopPreviewImageBytes } from './animated-image'
import { inspectDesktopAudioBytes, type DesktopAudioKind } from './audio-bytes'
import { inspectDesktopVideoBytes, type DesktopVideoKind } from './video-bytes'

// Root generates real encoded media with installed ffmpeg/img2webp; these same bytes are
// opened from Files in native acceptance. Normal source suites need no external encoder.
const fixtures = process.env.RERUN_MEDIA_ACCEPTANCE_DIR
for (const extension of ['gif','webp','m4a','ogg','flac','webm','mov','m4v']) {
    test.skipIf(!fixtures)(`recognizes real ${extension} bytes without changing their contents`, async () => {
        const bytes = await readFile(join(fixtures!, `round28.${extension}`)), before = Buffer.from(bytes)
        if (extension === 'gif' || extension === 'webp') {
            const image = inspectDesktopPreviewImageBytes(extension, bytes)
            expect(image.animated).toBe(true); expect(image.frames).toBeGreaterThan(1)
        } else if (['m4a','ogg','flac'].includes(extension)) expect(inspectDesktopAudioBytes(extension as DesktopAudioKind, bytes).contentType).toMatch(/^audio\//)
        else expect(inspectDesktopVideoBytes(extension as DesktopVideoKind, bytes).contentType).toMatch(/^video\//)
        expect(bytes.equals(before)).toBe(true)
    })
}
