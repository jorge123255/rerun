import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { z } from 'zod'
import { HttpError } from '../lib/errors.js'

let frozen = process.env.RERUN_DESKTOP_ADMISSIONS_FROZEN === '1'
let epoch = 0
let lastSequence = 0
let lastAction: 'freeze' | 'unfreeze' | undefined
let changed: (() => Promise<void>) | undefined
export function observeDesktopAdmissionChange(listener: () => Promise<void>) { changed = listener }
export function assertDesktopRunAdmission(expectedEpoch?: number): number {
    if (process.env.RERUN_DESKTOP_APP !== '1') return 0
    if (frozen || expectedEpoch !== undefined && expectedEpoch !== epoch) throw new HttpError(409, 'This workspace is switching. Try again when it is ready.')
    return epoch
}
export function createDesktopWorkspaceAdmissionRouter(options: { readRuntime?: (file: string) => Promise<unknown> } = {}) {
    const router = new Hono()
    router.post('/', async c => {
        if (process.env.RERUN_DESKTOP_APP !== '1' || !process.env.RERUN_DESKTOP_RUNTIME_FILE) throw new HttpError(404, 'Not found')
        const input = z.object({ action: z.enum(['freeze', 'unfreeze']), launchNonce: z.string().uuid(), workspaceId: z.number().int().positive(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().parse(await c.req.json())
        const raw = options.readRuntime ? await options.readRuntime(process.env.RERUN_DESKTOP_RUNTIME_FILE) : JSON.parse(await readFile(process.env.RERUN_DESKTOP_RUNTIME_FILE, 'utf8'))
        const runtime = z.object({ launchNonce: z.string(), workspaceId: z.number().int().positive(), engine: z.object({ apiKey: z.string() }) }).parse(raw)
        if (input.launchNonce !== runtime.launchNonce || input.workspaceId !== runtime.workspaceId || runtime.engine?.apiKey !== process.env.RERUN_API_KEY) throw new HttpError(409, 'Workspace process identity changed')
        // Check after the asynchronous identity read: an older queued freeze must
        // never overwrite a newer confirmed unfreeze. Same sequence replays only the same action.
        if (input.sequence < lastSequence || input.sequence === lastSequence && input.action !== lastAction) throw new HttpError(409, 'Workspace admission request is stale')
        lastSequence = input.sequence; lastAction = input.action
        if (frozen !== (input.action === 'freeze')) { frozen = input.action === 'freeze'; ++epoch }
        await changed?.()
        return c.json({ ok: true, frozen, launchNonce: input.launchNonce, workspaceId: input.workspaceId, sequence: input.sequence })
    })
    return router
}
