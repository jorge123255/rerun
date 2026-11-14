import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The Codex provider is patched in place. These are the two changes an image turn on a ChatGPT plan
// depends on; without the second one the provider drops the whole notification and the run hangs.
describe('the Codex provider patch', () => {
    const patch = readFileSync(resolve(import.meta.dirname, '../../patches/ai-sdk-provider-codex-cli@1.3.1.patch'), 'utf8')
    const added = (line: string) => patch.split('\n').filter(row => row.startsWith('+') && row.includes(line)).length

    it('names the image tool in both builds', () => {
        expect(added('if (type === "imagegeneration") {')).toBe(2)
        expect(added('return { toolName: "image_generation", dynamic: true };')).toBe(2)
    })

    it('keeps image and unknown items instead of failing the notification, in both builds', () => {
        expect(added('type: z.literal("imageGeneration")') + added('type: zod.z.literal("imageGeneration")')).toBe(2)
        expect(added('unknownItemSchema')).toBe(4)
    })
})
