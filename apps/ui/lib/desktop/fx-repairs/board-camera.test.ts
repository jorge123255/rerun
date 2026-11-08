import { afterEach, expect, test, vi } from 'vitest'
import { FxBoardCameraController, fxCameraSchema, unavailableFxCameraPersistence, type FxCameraPersistence, type FxCameraWrite } from './board-camera'
const camera = { pan: { x: 42, y: -31 }, zoom: 1.2 }
afterEach(() => vi.useRealTimers())
test('restore is observational, restores exact saved framing and does not cross workspace identity', async () => {
    const write = vi.fn(), port: FxCameraPersistence = { read: async id => ({ workspaceId: id, revision: 3, camera }), write }
    let current = 1
    const controller = new FxBoardCameraController(1, port, () => current)
    await controller.load()
    expect(controller.snapshot().initialCamera).toEqual(camera); expect(write).not.toHaveBeenCalled()
    current = 2; controller.change({ ...camera, zoom: 2 }); expect(await controller.flush()).toBe(false)
    expect(write).not.toHaveBeenCalled(); controller.close()
})
test('lost acknowledgement is uncertain and requires explicit same-ID retry; no timer replays it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const inputs: FxCameraWrite[] = []
    const port: FxCameraPersistence = { read: async () => ({ workspaceId: 1, revision: 0, camera: null }), write: async input => {
        inputs.push(input); if (inputs.length === 1) throw Error('Lost ACK')
        return { status: 'saved', requestId: input.requestId, snapshot: { workspaceId: 1, revision: input.expectedRevision + 1, camera: input.camera } }
    } }
    const controller = new FxBoardCameraController(1, port, () => 1); await controller.load(); controller.change(camera)
    await controller.flush(); expect(controller.snapshot().phase).toBe('uncertain')
    await vi.runAllTimersAsync(); expect(inputs).toHaveLength(1)
    expect(await controller.flush()).toBe(false); expect(await controller.retry()).toBe(true)
    expect(inputs[1]).toEqual(inputs[0]); controller.close()
})
test('final flush drains the latest human framing and close never initiates another save', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const write = vi.fn<FxCameraPersistence['write']>(async input => ({ status: 'saved', requestId: input.requestId, snapshot: { workspaceId: 1, revision: input.expectedRevision + 1, camera: input.camera } }))
    const controller = new FxBoardCameraController(1, { read: async () => ({ workspaceId: 1, revision: 0, camera: null }), write }, () => 1)
    await controller.load(); controller.change(camera); await controller.flush()
    const final = { pan: { x: -80, y: 77 }, zoom: 0.7 }; controller.change(final)
    expect(await controller.flush()).toBe(true); expect(write.mock.calls.at(-1)?.[0].camera).toEqual(final)
    controller.close(); await vi.runAllTimersAsync(); expect(write).toHaveBeenCalledTimes(2)
})
test('missing authority, corrupt camera and late load are truthful and never treated as saved', async () => {
    expect(fxCameraSchema.safeParse({ ...camera, zoom: 9 }).success).toBe(false)
    expect(fxCameraSchema.safeParse({ ...camera, pan: { x: Infinity, y: 0 } }).success).toBe(false)
    const missing = new FxBoardCameraController(1, unavailableFxCameraPersistence, () => 1)
    await missing.load(); expect(missing.snapshot().phase).toBe('unavailable'); expect(missing.snapshot().ready).toBe(false)
    missing.useDefaultView(); expect(missing.snapshot().ready).toBe(true); expect(await missing.flush()).toBe(false); missing.close()
    let resolve!: (value: { workspaceId: number; revision: number; camera: typeof camera }) => void
    const late = new FxBoardCameraController(1, { read: async () => new Promise(done => { resolve = done }), write: vi.fn() }, () => 1)
    const read = late.load(); late.close(); resolve({ workspaceId: 1, revision: 1, camera }); await read
    expect(late.snapshot().ready).toBe(false)
})
