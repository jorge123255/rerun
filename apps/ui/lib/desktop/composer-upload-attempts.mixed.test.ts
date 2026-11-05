import { afterEach, expect, test, vi } from 'vitest'
import { desktopUploadAttemptsSchema, desktopUploadReserveSchema, readDesktopUploadAttempts } from './composer-upload-attempts'
import { readDesktopImageUploadAttempts } from './composer-image-attempts'

afterEach(() => vi.unstubAllGlobals())
const attempt = (name: string, size: number) => ({ id: crypto.randomUUID(), name, size })

test('one durable response hydrates text and image statuses without applying text caps to images', async () => {
    const text = attempt('notes.md', 32 * 1024), image = attempt('photo.webp', 8 * 1024 * 1024)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ attempts: [text, image] })))
    expect(await readDesktopUploadAttempts('coworker', 'tab')).toEqual([text])
    expect(await readDesktopImageUploadAttempts('coworker', 'tab')).toEqual([image])
})

test('reservation and hydration accept the combined cap while retaining per-file limits', () => {
    const attempts = [...Array.from({ length: 10 }, (_, i) => attempt(`note-${i}.txt`, 32 * 1024)),
        ...Array.from({ length: 4 }, (_, i) => attempt(`photo-${i}.png`, 8 * 1024 * 1024))]
    expect(desktopUploadAttemptsSchema.safeParse({ attempts }).success).toBe(true)
    expect(desktopUploadAttemptsSchema.safeParse({ attempts: [...attempts, attempt('overflow.txt', 1)] }).success).toBe(false)
    for (const item of attempts) expect(desktopUploadReserveSchema.safeParse({ tabUid: 'tab', ...item }).success).toBe(true)
    for (const item of [attempt('oversize.txt', 32 * 1024 + 1), attempt('oversize.png', 8 * 1024 * 1024 + 1), attempt('.hidden.png', 1), attempt('../escape.txt', 1)]) {
        expect(desktopUploadReserveSchema.safeParse({ tabUid: 'tab', ...item }).success).toBe(false)
    }
})
