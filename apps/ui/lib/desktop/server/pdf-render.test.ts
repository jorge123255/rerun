import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_PDF_PNG_MAX_BYTES, DESKTOP_PDF_RENDER_TIMEOUT_MS, renderDesktopPdf } from './pdf-render'
import { DESKTOP_PDF_MAX_BYTES } from './pdf-bytes'

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: processMock.spawn }))

const input = Buffer.from('%PDF-1.4\nfixture\n%%EOF\n')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const header = { page: 1, pageCount: 2, width: 1, height: 1, pageWidth: 612, pageHeight: 792 }
const output = (metadata: Record<string, unknown> = header, body = png) => Buffer.concat([Buffer.from(JSON.stringify(metadata) + '\n'), body])

function renderer() {
    const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
    })
    const received: Buffer[] = []
    child.stdin.on('data', (chunk: Buffer) => received.push(chunk))
    return {
        child, received,
        close: (code = 0) => child.emit('close', code, null),
        complete: (bytes = output()) => { child.stdout.write(bytes); child.emit('close', 0, null) },
    }
}

beforeEach(() => {
    processMock.spawn.mockReset()
    vi.stubEnv('RERUN_DESKTOP_PDF_HELPER', '/bundle/pdf-page')
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

test('sends bytes only to the fixed helper and accepts a split metadata line plus a matching inert PNG', async () => {
    const process = renderer()
    processMock.spawn.mockReturnValue(process.child)
    vi.stubEnv('OPENAI_API_KEY', 'test-only-must-not-be-inherited')
    const pending = renderDesktopPdf(input, { page: 2, scale: 1.5 })
    expect(processMock.spawn).toHaveBeenCalledWith('/bundle/pdf-page', ['2', '1.5'], {
        stdio: ['pipe', 'pipe', 'pipe'], shell: false, cwd: '/', env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    })
    expect(Buffer.concat(process.received)).toEqual(input)
    const bytes = output({ ...header, page: 2 })
    process.child.stdout.write(bytes.subarray(0, 12))
    process.child.stdout.write(bytes.subarray(12))
    process.close()
    const result = await pending
    expect(result).toMatchObject({ ...header, page: 2 })
    expect(Buffer.from(result.png)).toEqual(png)
    expect(process.child.kill).not.toHaveBeenCalled()
})

test('an aborted request kills the helper and does not settle or release its slot until close', async () => {
    const process = renderer()
    processMock.spawn.mockReturnValue(process.child)
    const controller = new AbortController()
    const pending = renderDesktopPdf(input, { signal: controller.signal })
    let settled = false
    const observed = pending.then(() => { settled = true }, () => { settled = true })
    controller.abort()
    expect(process.child.kill).toHaveBeenCalledWith('SIGKILL')
    await Promise.resolve()
    expect(settled).toBe(false)
    process.close(1)
    await expect(pending).rejects.toMatchObject({ status: 499 })
    await observed
})

test('the render deadline kills and waits for close before reporting timeout', async () => {
    vi.useFakeTimers()
    const process = renderer()
    processMock.spawn.mockReturnValue(process.child)
    const pending = renderDesktopPdf(input)
    const refused = expect(pending).rejects.toMatchObject({ status: 504 })
    vi.advanceTimersByTime(DESKTOP_PDF_RENDER_TIMEOUT_MS)
    expect(process.child.kill).toHaveBeenCalledWith('SIGKILL')
    process.close(1)
    await refused
})

test.each([
    ['oversized stdout', 'stdout', Buffer.alloc(DESKTOP_PDF_PNG_MAX_BYTES + 1026), 413],
    ['unterminated metadata', 'stdout', Buffer.alloc(1025, 65), 422],
    ['oversized stderr', 'stderr', Buffer.alloc(4097, 65), 422],
] as const)('%s kills the helper without retaining or returning partial output', async (_label, stream, bytes, status) => {
    const process = renderer()
    processMock.spawn.mockReturnValue(process.child)
    const pending = renderDesktopPdf(input)
    const refused = expect(pending).rejects.toMatchObject({ status })
    process.child[stream].write(bytes)
    expect(process.child.kill).toHaveBeenCalledWith('SIGKILL')
    process.close(1)
    await refused
})

test.each([
    ['mismatched page', { ...header, page: 2 }],
    ['out of range page count', { ...header, pageCount: 10001 }],
    ['oversized dimension', { ...header, width: 4097 }],
    ['oversized pixel area', { ...header, width: 4096, height: 4096 }],
    ['PNG dimensions differ', { ...header, width: 2 }],
    ['invalid page geometry', { ...header, pageHeight: 0 }],
] as const)('rejects helper metadata with %s', async (_label, metadata) => {
    const process = renderer()
    processMock.spawn.mockReturnValue(process.child)
    const pending = renderDesktopPdf(input)
    const refused = expect(pending).rejects.toMatchObject({ status: 422 })
    process.complete(output(metadata))
    await refused
})

test.each([
    ['PDF bytes', input], ['truncated PNG', png.subarray(0, png.length - 1)], ['HTML bytes', Buffer.from('<script>untrusted</script>')],
] as const)('never returns %s as a raster', async (_label, body) => {
    const process = renderer()
    processMock.spawn.mockReturnValue(process.child)
    const pending = renderDesktopPdf(input)
    const refused = expect(pending).rejects.toMatchObject({ status: 422 })
    process.complete(output(header, body))
    await refused
})

test('helper failure does not reveal stderr, paths, or document text', async () => {
    const process = renderer()
    processMock.spawn.mockReturnValue(process.child)
    const pending = renderDesktopPdf(input)
    const refused = expect(pending).rejects.toMatchObject({ status: 422,
        message: 'Could not display this PDF page. The file may be damaged, encrypted, or unsupported.' })
    process.child.stderr.write('private-document-text /private/source/path.pdf')
    process.close(1)
    await refused
})

test('invalid page, zoom, byte size, missing helper and already aborted calls spawn nothing', async () => {
    for (const options of [{ page: 0 }, { page: 10001 }, { page: 1.5 }, { scale: 0.49 }, { scale: 2.01 }, { scale: Number.NaN }]) {
        await expect(renderDesktopPdf(input, options)).rejects.toMatchObject({ status: 400 })
    }
    await expect(renderDesktopPdf(Buffer.alloc(DESKTOP_PDF_MAX_BYTES + 1))).rejects.toMatchObject({ status: 413 })
    const abort = new AbortController(); abort.abort()
    await expect(renderDesktopPdf(input, { signal: abort.signal })).rejects.toMatchObject({ status: 499 })
    vi.stubEnv('RERUN_DESKTOP_PDF_HELPER', '')
    await expect(renderDesktopPdf(input)).rejects.toMatchObject({ status: 503 })
    vi.stubEnv('RERUN_DESKTOP_PDF_HELPER', 'host-tool')
    await expect(renderDesktopPdf(input)).rejects.toMatchObject({ status: 503 })
    expect(processMock.spawn).not.toHaveBeenCalled()
})

test('at most two helpers run, and completed helpers free their admission slots', async () => {
    const first = renderer(), second = renderer(), third = renderer()
    processMock.spawn.mockReturnValueOnce(first.child).mockReturnValueOnce(second.child).mockReturnValueOnce(third.child)
    const a = renderDesktopPdf(input), b = renderDesktopPdf(input)
    await expect(renderDesktopPdf(input)).rejects.toMatchObject({ status: 503 })
    first.complete(); await a
    const c = renderDesktopPdf(input)
    second.complete(); third.complete()
    await Promise.all([b, c])
    expect(processMock.spawn).toHaveBeenCalledTimes(3)
})

test('a spawn failure releases admission without falling back to a host converter', async () => {
    processMock.spawn.mockImplementationOnce(() => { throw new Error('spawn failed') })
    await expect(renderDesktopPdf(input)).rejects.toMatchObject({ status: 503 })
    const process = renderer()
    processMock.spawn.mockReturnValue(process.child)
    const pending = renderDesktopPdf(input)
    process.complete()
    await expect(pending).resolves.toMatchObject(header)
    expect(processMock.spawn).toHaveBeenCalledTimes(2)
})
