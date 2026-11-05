import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_PDF_TEXT_MAX_STDOUT, type DesktopPdfTextExtract } from '@/lib/desktop/pdf-text'
import { DESKTOP_PDF_MAX_BYTES } from './pdf-bytes'
import { DESKTOP_PDF_TEXT_TIMEOUT_MS, extractDesktopPdfText } from './pdf-text'

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: processMock.spawn }))

const input = Buffer.from('%PDF-1.4\nfixture\n%%EOF\n')
const extract: DesktopPdfTextExtract = {
    pageCount: 1, truncated: false, reason: '',
    pages: [{ page: 1, rotation: 0, crop: { x: 0, y: 0, width: 612, height: 792 }, pageWidth: 612, pageHeight: 792, text: 'Alpha one', runs: [{ start: 0, end: 5, x: 0.1, y: 0.2, w: 0.2, h: 0.03 }] }],
}
const output = (value: unknown = extract) => Buffer.from(`${JSON.stringify(value)}\n`)

function reader() {
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
    vi.stubEnv('RERUN_DESKTOP_PDF_TEXT_HELPER', '/bundle/pdf-text')
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

test('sends stdin bytes to the fixed helper with an empty argument list and accepts one JSON line', async () => {
    const process = reader()
    processMock.spawn.mockReturnValue(process.child)
    vi.stubEnv('OPENAI_API_KEY', 'test-only-must-not-be-inherited')
    const pending = extractDesktopPdfText(input)
    expect(processMock.spawn).toHaveBeenCalledWith('/bundle/pdf-text', [], {
        stdio: ['pipe', 'pipe', 'pipe'], shell: false, cwd: '/', env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    })
    expect(Buffer.concat(process.received)).toEqual(input)
    process.complete()
    await expect(pending).resolves.toEqual(extract)
    expect(process.child.kill).not.toHaveBeenCalled()
})

test('an aborted request kills the helper and does not settle until close', async () => {
    const process = reader()
    processMock.spawn.mockReturnValue(process.child)
    const controller = new AbortController()
    const pending = extractDesktopPdfText(input, { signal: controller.signal })
    let settled = false
    const observed = pending.then(() => { settled = true }, () => { settled = true })
    controller.abort()
    expect(process.child.kill).toHaveBeenCalledWith('SIGKILL')
    await Promise.resolve()
    expect(settled).toBe(false)
    process.close(1)
    await expect(pending).rejects.toMatchObject({ status: 499, message: 'PDF text was closed.' })
    await observed
})

test('the read deadline kills and waits for close before reporting timeout', async () => {
    vi.useFakeTimers()
    const process = reader()
    processMock.spawn.mockReturnValue(process.child)
    const pending = extractDesktopPdfText(input)
    const refused = expect(pending).rejects.toMatchObject({ status: 504, message: 'This PDF’s text took too long to read.' })
    vi.advanceTimersByTime(DESKTOP_PDF_TEXT_TIMEOUT_MS)
    expect(process.child.kill).toHaveBeenCalledWith('SIGKILL')
    process.close(1)
    await refused
})

test('oversized stdout and stderr are killed without returning helper bytes or stderr text', async () => {
    const oversized = reader()
    processMock.spawn.mockReturnValue(oversized.child)
    const pending = extractDesktopPdfText(input)
    const refused = expect(pending).rejects.toMatchObject({ status: 413, message: 'PDF text is too large to search.' })
    oversized.child.stdout.write(Buffer.alloc(DESKTOP_PDF_TEXT_MAX_STDOUT + 1))
    expect(oversized.child.kill).toHaveBeenCalledWith('SIGKILL')
    oversized.close(1)
    await refused
    const noisy = reader()
    processMock.spawn.mockReturnValue(noisy.child)
    const hidden = extractDesktopPdfText(input)
    const generic = expect(hidden).rejects.toMatchObject({ status: 422, message: 'Could not read this PDF’s text. The file may be damaged, encrypted, or have no supported text.' })
    noisy.child.stderr.write(Buffer.from('%PDF- private /tmp/secret.pdf'))
    noisy.close(1)
    await generic
})

test.each([
    ['raw pdf', input],
    ['embedded newline', Buffer.from(`${JSON.stringify(extract)}\n\n`)],
    ['missing newline', Buffer.from(JSON.stringify(extract))],
    ['nul', Buffer.concat([Buffer.from('{'), Buffer.from([0]), Buffer.from('}\n')])],
    ['bad rotation', output({ ...extract, pages: [{ ...extract.pages[0], rotation: 45 as 0 }] })],
] as const)('rejects %s instead of treating it as searchable text', async (_label, bytes) => {
    const process = reader()
    processMock.spawn.mockReturnValue(process.child)
    const pending = extractDesktopPdfText(input)
    const refused = expect(pending).rejects.toMatchObject({ status: 422 })
    process.complete(bytes)
    await refused
})

test('invalid bytes, a missing or relative helper, and an already aborted call spawn nothing', async () => {
    await expect(extractDesktopPdfText(Buffer.alloc(0))).rejects.toMatchObject({ status: 422 })
    await expect(extractDesktopPdfText(Buffer.alloc(DESKTOP_PDF_MAX_BYTES + 1))).rejects.toMatchObject({ status: 413 })
    const abort = new AbortController(); abort.abort()
    await expect(extractDesktopPdfText(input, { signal: abort.signal })).rejects.toMatchObject({ status: 499 })
    vi.stubEnv('RERUN_DESKTOP_PDF_TEXT_HELPER', '')
    await expect(extractDesktopPdfText(input)).rejects.toMatchObject({ status: 503 })
    vi.stubEnv('RERUN_DESKTOP_PDF_TEXT_HELPER', 'host-tool')
    await expect(extractDesktopPdfText(input)).rejects.toMatchObject({ status: 503 })
    expect(processMock.spawn).not.toHaveBeenCalled()
})

test('at most two helpers run, and a finished helper frees its slot', async () => {
    const first = reader(), second = reader(), third = reader()
    processMock.spawn.mockReturnValueOnce(first.child).mockReturnValueOnce(second.child).mockReturnValueOnce(third.child)
    const a = extractDesktopPdfText(input), b = extractDesktopPdfText(input)
    await expect(extractDesktopPdfText(input)).rejects.toMatchObject({ status: 503 })
    first.complete(); await a
    const c = extractDesktopPdfText(input)
    second.complete(); third.complete()
    await Promise.all([b, c])
    expect(processMock.spawn).toHaveBeenCalledTimes(3)
})

test('a spawn failure releases admission without searching PATH', async () => {
    processMock.spawn.mockImplementationOnce(() => { throw new Error('spawn failed') })
    await expect(extractDesktopPdfText(input)).rejects.toMatchObject({ status: 503 })
    const process = reader()
    processMock.spawn.mockReturnValue(process.child)
    const pending = extractDesktopPdfText(input)
    process.complete()
    await expect(pending).resolves.toEqual(extract)
    expect(processMock.spawn).toHaveBeenCalledTimes(2)
})
