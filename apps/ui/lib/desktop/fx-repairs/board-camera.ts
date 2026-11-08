import { z } from 'zod'
import { desktopWorkspaceIdSchema } from '@rerun/contracts'
import type { IsoCamera } from '@rerun/ui/iso-grid'

export const fxCameraSchema = z.object({ pan: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(), zoom: z.number().min(0.3).max(3) }).strict()
export const fxCameraSnapshotSchema = z.object({ workspaceId: desktopWorkspaceIdSchema, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), camera: fxCameraSchema.nullable() }).strict()
export const fxCameraWriteSchema = z.object({ workspaceId: desktopWorkspaceIdSchema, requestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 2), camera: fxCameraSchema }).strict()
export type FxCameraSnapshot = z.infer<typeof fxCameraSnapshotSchema>
export type FxCameraWrite = z.infer<typeof fxCameraWriteSchema>
export const fxCameraResultSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('saved'), requestId: z.string().uuid(), snapshot: fxCameraSnapshotSchema }).strict(),
    z.object({ status: z.literal('conflict'), snapshot: fxCameraSnapshotSchema }).strict(),
])
export type FxCameraResult = z.infer<typeof fxCameraResultSchema>
export type FxCameraPersistence = {
    read(workspaceId: number, signal: AbortSignal): Promise<FxCameraSnapshot>
    write(input: FxCameraWrite, signal: AbortSignal): Promise<FxCameraResult>
}
export const unavailableFxCameraPersistence: FxCameraPersistence = {
    read: async () => { throw Error('Board view storage is unavailable.') },
    write: async () => { throw Error('Board view storage is unavailable.') },
}
export const sameFxCamera = (a: IsoCamera | null, b: IsoCamera | null) => a === b || !!a && !!b && a.zoom === b.zoom && a.pan.x === b.pan.x && a.pan.y === b.pan.y

export type FxCameraState = {
    phase: 'loading' | 'ready' | 'saving' | 'uncertain' | 'conflict' | 'unavailable'
    ready: boolean; initialCamera: IsoCamera | null; mountGeneration: number; error: string
}
export class FxBoardCameraController {
    private state: FxCameraState = { phase: 'loading', ready: false, initialCamera: null, mountGeneration: 0, error: '' }
    private listeners = new Set<() => void>()
    private saved: FxCameraSnapshot | null = null
    private pending: IsoCamera | null = null
    private attempt: FxCameraWrite | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private work: Promise<boolean> | null = null
    private controller = new AbortController()
    private generation = 0
    private closed = false
    private lastWriteAt = 0
    constructor(readonly workspaceId: number, private port: FxCameraPersistence, private currentWorkspace: () => number | null) {}
    snapshot = () => this.state
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private current = () => !this.closed && this.currentWorkspace() === this.workspaceId
    private publish(patch: Partial<FxCameraState>) { if (this.current()) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() } }
    async load() {
        if (!this.current() || this.state.phase === 'saving') return
        this.controller.abort(); this.controller = new AbortController()
        this.work = null
        const generation = ++this.generation, signal = this.controller.signal
        this.clearTimer(); this.pending = null; this.attempt = null
        this.publish({ phase: 'loading', error: '' })
        try {
            const saved = fxCameraSnapshotSchema.parse(await this.port.read(this.workspaceId, signal))
            if (saved.workspaceId !== this.workspaceId) throw Error()
            if (!this.current() || signal.aborted || generation !== this.generation) return
            this.saved = saved
            this.publish({ phase: 'ready', ready: true, initialCamera: saved.camera, mountGeneration: this.state.mountGeneration + 1, error: '' })
        } catch { if (this.current() && !signal.aborted && generation === this.generation) this.publish({ phase: 'unavailable', error: 'Could not restore the board view. Retry or use the default view without saving.' }) }
    }
    useDefaultView() {
        if (!this.current() || this.state.phase === 'saving') return
        this.controller.abort(); ++this.generation; this.work = null; this.clearTimer(); this.pending = null; this.attempt = null; this.saved = null
        this.publish({ phase: 'unavailable', ready: true, initialCamera: null, mountGeneration: this.state.mountGeneration + 1, error: 'Board view saving is unavailable. The current workspace uses default framing.' })
    }
    change(camera: IsoCamera) {
        if (!this.current() || !this.saved || !['ready', 'saving'].includes(this.state.phase)) return
        const parsed = fxCameraSchema.safeParse(camera)
        if (!parsed.success || sameFxCamera(parsed.data, this.pending ?? this.attempt?.camera ?? this.saved.camera)) return
        this.pending = parsed.data
        this.schedule()
    }
    private schedule() {
        if (this.timer) return
        const remaining = Math.max(0, 250 - (Date.now() - this.lastWriteAt))
        if (!remaining && !this.work) { void this.flush(); return }
        this.timer = setTimeout(() => { this.timer = null; void this.flush() }, remaining || 250)
    }
    private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null }
    async flush(): Promise<boolean> {
        this.clearTimer()
        if (!this.current() || !this.saved || ['uncertain', 'conflict', 'unavailable', 'loading'].includes(this.state.phase)) return false
        if (this.work) { const okay = await this.work; return okay ? this.flush() : false }
        if (!this.pending) return true
        this.attempt = { workspaceId: this.workspaceId, requestId: crypto.randomUUID(), expectedRevision: this.saved.revision, camera: this.pending }
        this.pending = null
        return this.dispatch()
    }
    retry(): Promise<boolean> {
        if (!this.current() || !this.attempt || this.state.phase !== 'uncertain') return Promise.resolve(false)
        return this.dispatch()
    }
    private dispatch(): Promise<boolean> {
        const input = this.attempt!, generation = this.generation, signal = this.controller.signal
        this.lastWriteAt = Date.now()
        this.publish({ phase: 'saving', error: '' })
        const work = (async () => {
            try {
                const result = fxCameraResultSchema.parse(await this.port.write(structuredClone(input), signal))
                if (!this.current() || signal.aborted || generation !== this.generation) return false
                if (result.snapshot.workspaceId !== this.workspaceId) throw Error()
                if (result.status === 'conflict') { this.publish({ phase: 'conflict', error: 'The board view changed in another window. Load its saved view before saving again.' }); return false }
                if (result.requestId !== input.requestId || result.snapshot.revision !== input.expectedRevision + 1 || !sameFxCamera(result.snapshot.camera, input.camera)) throw Error()
                this.saved = result.snapshot; this.attempt = null
                this.publish({ phase: 'ready', error: '' })
                return true
            } catch {
                if (this.current() && !signal.aborted && generation === this.generation) this.publish({ phase: 'uncertain', error: 'Could not confirm the board view save. Retry the same request or explicitly load the saved view.' })
                return false
            }
        })()
        this.work = work
        void work.then(okay => { if (this.work === work) { this.work = null; if (okay && this.pending && this.current()) this.schedule() } })
        return work
    }
    close() { this.closed = true; ++this.generation; this.controller.abort(); this.clearTimer(); this.listeners.clear() }
}
