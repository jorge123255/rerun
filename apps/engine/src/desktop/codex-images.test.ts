import { mkdtempSync } from 'node:fs'
import { link, mkdir, readdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { fileCardSchema } from '@rerun/contracts'

const data = mkdtempSync(join(tmpdir(), 'rerun-codex-image-data-'))
const runRoot = mkdtempSync(join(tmpdir(), 'rerun-codex-image-run-'))
const outside = mkdtempSync(join(tmpdir(), 'rerun-codex-image-out-'))
const previousData = process.env.RERUN_DATA_DIR
process.env.RERUN_DATA_DIR = data
process.env.RERUN_API_KEY = ''
const { clearCachedEnvForTests } = await import('../config/env.js')
clearCachedEnvForTests()
const { workspaceDir } = await import('../config/paths.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { claimSession, releaseSession } = await import('../runtime/run-control.js')
import type { DesktopCodexImageContext } from './codex-images.js'
const { rewriteDesktopCodexImagePart } = await import('./codex-images.js')

const alpha = 'codex-image-alpha'
const sessionId = 'codex-image-session'
const runId = 'codex-image-run'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const png = Buffer.from(PNG, 'base64')
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const secret = Buffer.from('OUTSIDE-SECRET')

const config = (enabled: boolean) => agentConfigSchema.parse({ name: alpha, tools: { desktopToolGrants: { cardFile: enabled } } })
const context = (extra: Partial<DesktopCodexImageContext> = {}): DesktopCodexImageContext => ({
    provider: 'codex', agent: { id: alpha }, runId, sessionId, abortSignal: new AbortController().signal, runRoot, ...extra,
})
const imageResult = (result: Record<string, unknown>) => ({ type: 'tool-result' as const, toolName: 'image_generation', result })

async function generatedNames(): Promise<string[]> {
    try { return await readdir(join(workspaceDir(alpha), 'generated-images')) }
    catch { return [] }
}

async function underRun(extra: Partial<DesktopCodexImageContext>, body: (ctx: DesktopCodexImageContext) => Promise<void>) {
    const ctx = context(extra)
    expect(claimSession(ctx.sessionId, ctx.runId)).toBeNull()
    try { await body(ctx) }
    finally { releaseSession(ctx.runId) }
}

beforeAll(async () => {
    expect(png).toHaveLength(70)
    await mkdir(workspaceDir(alpha), { recursive: true })
    await writeAgentConfig(alpha, config(true))
    await writeFile(join(runRoot, 'ig_saved.png'), png)
    await writeFile(join(runRoot, 'empty.png'), Buffer.alloc(0))
    await writeFile(join(runRoot, 'big.png'), '')
    await truncate(join(runRoot, 'big.png'), 8 * 1024 * 1024 + 1)
    await writeFile(join(outside, 'secret.png'), secret)
    await symlink(join(outside, 'secret.png'), join(runRoot, 'linked.png'))
    await link(join(outside, 'secret.png'), join(runRoot, 'hard.png'))
})

afterAll(async () => {
    releaseSession(runId)
    releaseSession('other-run')
    if (previousData === undefined) delete process.env.RERUN_DATA_DIR
    else process.env.RERUN_DATA_DIR = previousData
    clearCachedEnvForTests()
    await rm(data, { recursive: true, force: true })
    await rm(runRoot, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
})

it('copies an inline image into this coworker’s Files and strips the bytes from the card', async () => {
    await underRun({}, async ctx => {
        const part = await rewriteDesktopCodexImagePart(ctx, imageResult({ id: 'ig_inline', result: PNG }))
        const card = fileCardSchema.parse(part.result)
        expect(card.files).toEqual([expect.objectContaining({
            path: 'generated-images/ig_inline.png', name: 'ig_inline.png', size: 70, scope: 'agent',
        })])
        expect(card.files[0]?.identity).toMatch(/^\d{1,24}:\d{1,24}$/)
        expect(JSON.stringify(part)).not.toContain(PNG)
        expect(await readFile(join(workspaceDir(alpha), 'generated-images/ig_inline.png'))).toEqual(png)
    })
})

it('copies a regular image from the approved run and leaves the source in place', async () => {
    await underRun({}, async ctx => {
        const part = await rewriteDesktopCodexImagePart(ctx, imageResult({
            id: 'ig_saved', savedPath: join(runRoot, 'ig_saved.png'), result: jpeg.toString('base64'),
        }))
        const card = fileCardSchema.parse(part.result)
        expect(card.files[0]).toEqual(expect.objectContaining({ path: 'generated-images/ig_saved.png', name: 'ig_saved.png', size: 70 }))
        expect(await readFile(join(workspaceDir(alpha), card.files[0]!.path))).toEqual(png)
        expect(await readFile(join(runRoot, 'ig_saved.png'))).toEqual(png)
    })
})

it('names an inline jpeg from its bytes', async () => {
    await underRun({}, async ctx => {
        const part = await rewriteDesktopCodexImagePart(ctx, imageResult({ id: 'ig_jpeg', result: jpeg.toString('base64') }))
        expect(fileCardSchema.parse(part.result).files[0]?.path).toBe('generated-images/ig_jpeg.jpg')
    })
})

it('keeps a traversal id inside generated-images', async () => {
    await underRun({}, async ctx => {
        const part = await rewriteDesktopCodexImagePart(ctx, imageResult({ id: '../escape', result: PNG }))
        expect(fileCardSchema.parse(part.result).files[0]?.path).toBe('generated-images/escape.png')
        expect(await generatedNames()).toContain('escape.png')
    })
})

it('does not replace an image already in this coworker’s Files', async () => {
    const target = join(workspaceDir(alpha), 'generated-images/ig_keep.png')
    await mkdir(join(workspaceDir(alpha), 'generated-images'), { recursive: true })
    await writeFile(target, Buffer.from('keep-me'))
    await underRun({}, async ctx => {
        const part = await rewriteDesktopCodexImagePart(ctx, imageResult({ id: 'ig_keep', result: PNG }))
        expect(part).toMatchObject({ isError: true, result: { error: expect.stringMatching(/already in this coworker/) } })
        expect(await readFile(target)).toEqual(Buffer.from('keep-me'))
    })
})

it('refuses a saved image outside the run, a link, a hard link, an empty file and an oversized file', async () => {
    const cases = [
        join(outside, 'secret.png'),
        join(runRoot, 'linked.png'),
        join(runRoot, 'hard.png'),
        join(runRoot, 'empty.png'),
        join(runRoot, 'big.png'),
    ]
    for (const savedPath of cases) {
        await underRun({}, async ctx => {
            const before = await generatedNames()
            const part = await rewriteDesktopCodexImagePart(ctx, imageResult({ id: 'ig_refuse', savedPath }))
            expect(part).toMatchObject({ isError: true })
            expect(JSON.stringify(part)).not.toContain(savedPath)
            expect(JSON.stringify(part)).not.toContain('OUTSIDE-SECRET')
            expect(await generatedNames()).toEqual(before)
        })
    }
    const written = await Promise.all((await generatedNames()).map(async name => readFile(join(workspaceDir(alpha), 'generated-images', name))))
    expect(written.some(bytes => bytes.includes(secret))).toBe(false)
})

it('refuses a saved image when this run has no approved root', async () => {
    await underRun({ runRoot: undefined }, async ctx => {
        const part = await rewriteDesktopCodexImagePart(ctx, imageResult({ id: 'ig_noroot', savedPath: join(runRoot, 'ig_saved.png') }))
        expect(part).toMatchObject({ isError: true, result: { error: expect.stringMatching(/outside this run/) } })
        expect(await generatedNames()).not.toContain('ig_noroot.png')
    })
})

it('reports image generation unavailable for another adapter and copies nothing', async () => {
    for (const provider of ['grok', 'rerun']) {
        await underRun({ provider }, async ctx => {
            const part = await rewriteDesktopCodexImagePart(ctx, imageResult({
                id: 'ig_adapter', savedPath: join(runRoot, 'ig_saved.png'), result: PNG,
            }))
            expect(part).toMatchObject({ isError: true, result: { error: 'Image generation is not available on this adapter.' } })
            expect(JSON.stringify(part)).not.toContain(PNG)
            expect(await generatedNames()).not.toContain('ig_adapter.png')
        })
    }
})

it('reports image generation unavailable when the session claim is a different run', async () => {
    expect(claimSession(sessionId, 'other-run')).toBeNull()
    try {
        const part = await rewriteDesktopCodexImagePart(context(), imageResult({ id: 'ig_claim', result: PNG }))
        expect(part).toMatchObject({ isError: true, result: { error: 'Image generation is not available for this run.' } })
        expect(await generatedNames()).not.toContain('ig_claim.png')
    } finally { releaseSession('other-run') }
})

it('reports image generation unavailable without the file-card grant and copies nothing', async () => {
    await writeAgentConfig(alpha, config(false))
    try {
        await underRun({}, async ctx => {
            const part = await rewriteDesktopCodexImagePart(ctx, imageResult({ id: 'ig_grant', result: PNG }))
            expect(part).toMatchObject({ isError: true, result: { error: 'Image generation is not available for this coworker.' } })
            expect(await generatedNames()).not.toContain('ig_grant.png')
        })
    } finally { await writeAgentConfig(alpha, config(true)) }
})

it('does not copy when the run has been aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(underRun({ abortSignal: controller.signal }, async ctx => {
        await rewriteDesktopCodexImagePart(ctx, imageResult({ id: 'ig_abort', result: PNG }))
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(await generatedNames()).not.toContain('ig_abort.png')
})

it('keeps a Codex failure without writing a file', async () => {
    await underRun({}, async ctx => {
        const part = await rewriteDesktopCodexImagePart(ctx, imageResult({
            id: 'ig_failed', status: 'failed', failure: 'Image generation is not available on this plan',
        }))
        expect(part).toMatchObject({ isError: true, result: { error: 'Image generation is not available on this plan' } })
        expect(await generatedNames()).not.toContain('ig_failed.png')
    })
})

it('shrinks image input, drops a preliminary result and leaves other tools unchanged', async () => {
    const ctx = context()
    const input = JSON.stringify({ id: 'ig_1', revisedPrompt: 'a red square', result: PNG })
    const call = await rewriteDesktopCodexImagePart(ctx, { type: 'tool-call', toolName: 'image_generation', input })
    expect(JSON.parse(call.input)).toEqual({ prompt: 'a red square' })
    const preliminary = await rewriteDesktopCodexImagePart(ctx, { type: 'tool-result', toolName: 'image_generation', preliminary: true, result: PNG })
    expect(preliminary.result).toEqual({})
    const other = { type: 'tool-result', toolName: 'card_file', result: { kind: 'file', files: [] } }
    expect(await rewriteDesktopCodexImagePart(ctx, other)).toEqual(other)
})
