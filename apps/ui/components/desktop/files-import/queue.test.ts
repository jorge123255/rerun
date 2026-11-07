// Authored for the integration owner. This lane does not run it.
import { MAX_UPLOAD_FILE_BYTES } from '@rerun/contracts'
import { describe, expect, it } from 'vitest'
import { filesImportSettlement, filesImportShouldReload, FilesImportQueue } from './queue'
import { FilesImportWriteError, type FilesImportEntry, type FilesImportSaved, type FilesImportWriteRequest } from './types'

function entry(name: string, bytes: Uint8Array, subDir = ''): FilesImportEntry {
    return { name, subDir, size: bytes.byteLength, read: async () => bytes }
}

function oversized(name: string): FilesImportEntry {
    return { name, subDir: '', size: MAX_UPLOAD_FILE_BYTES + 1, read: async () => { throw new Error('read') } }
}

async function flush() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

function harness(write: (request: FilesImportWriteRequest) => Promise<FilesImportSaved>, concurrency = 3) {
    let time = 0
    const later: Array<{ at: number; fn: () => void }> = []
    const calls: string[] = []
    let rejected = ''
    const queue = new FilesImportQueue({
        write: async request => {
            calls.push(request.path)
            return write(request)
        },
        concurrency,
        onRejected: message => { rejected = message },
        schedule: (fn, ms) => { later.push({ at: time + ms, fn }) },
        now: () => time,
        id: (() => { let n = 0; return () => `id-${++n}` })(),
    })
    return {
        queue,
        calls,
        rejected: () => rejected,
        async due() {
            const ready = later.filter(item => item.at <= time)
            for (let i = later.length - 1; i >= 0; i -= 1) if (later[i]!.at <= time) later.splice(i, 1)
            for (const item of ready) item.fn()
            await flush()
        },
        async at(ms: number) {
            time = ms
            await this.due()
        },
    }
}

const saved = async (request: FilesImportWriteRequest): Promise<FilesImportSaved> => ({ saved: true, path: request.path })

describe('coworker Files import queue', () => {
    it('keeps a sibling when one file is refused', async () => {
        const run = harness(async request => {
            if (request.path === 'bad.txt') throw new FilesImportWriteError('Only text', 'http', 415)
            return { saved: true, path: request.path }
        })
        run.queue.enqueue([entry('bad.txt', Uint8Array.of(1)), entry('ok.txt', Uint8Array.of(2))])
        await flush()
        const receipt = run.queue.receipt()
        expect(receipt.savedCount).toBe(1)
        expect(receipt.failedCount).toBe(1)
        expect(receipt.items.find(item => item.path === 'ok.txt')).toMatchObject({ saved: true, status: 'done' })
        expect(receipt.items.find(item => item.path === 'bad.txt')).toMatchObject({ saved: false, status: 'error', code: 'http' })
        expect(filesImportSettlement(receipt.items)).toBe('1 of 2 files failed to import')
        expect(run.calls).toEqual(['bad.txt', 'ok.txt'])
    })

    it('joins a folder onto the open directory', async () => {
        const run = harness(saved)
        run.queue.enqueue([entry('a.txt', Uint8Array.of(1), 'sub')], 'docs')
        await flush()
        expect(run.calls).toEqual(['docs/sub/a.txt'])
        expect(run.queue.items()[0]).toMatchObject({ dir: 'docs/sub', path: 'docs/sub/a.txt', saved: true })
    })

    it('rejects an oversize file without dropping an eligible sibling or reading it', async () => {
        const run = harness(saved)
        const ids = run.queue.enqueue([oversized('huge.bin'), entry('ok.txt', Uint8Array.of(1))])
        await flush()
        expect(ids).toEqual(['id-1'])
        expect(run.rejected()).toBe('huge.bin is over the 100 MB limit.')
        expect(run.calls).toEqual(['ok.txt'])
    })

    it('refuses reserved aliases and keeps an ordinary hidden file', async () => {
        const run = harness(saved)
        run.queue.enqueue([
            entry('.gitignore', Uint8Array.of(1)),
            entry('.RERUN-skill-alias', Uint8Array.of(1)),
            entry('lock', Uint8Array.of(1), 'internal.rerun-notes'),
            entry('page.md', Uint8Array.of(1), '.rerun'),
        ])
        await flush()
        expect(run.calls).toEqual(['.gitignore'])
        const items = run.queue.items()
        expect(items.find(item => item.path === '.gitignore')).toMatchObject({ saved: true })
        expect(items.filter(item => item.code === 'reserved').map(item => item.path).sort()).toEqual(['.RERUN-skill-alias', '.rerun/page.md', 'internal.rerun-notes/lock'])
        expect(items.every(item => item.saved === true || item.code === 'reserved')).toBe(true)
    })

    it('refuses escaping and launchable names before the writer', async () => {
        const run = harness(saved)
        run.queue.enqueue([
            entry('a.txt', Uint8Array.of(1), '..'),
            entry('payload.exe', Uint8Array.of(1)),
            entry('bin', Uint8Array.of(1), 'Foo.app/MacOS'),
            entry('script.js', Uint8Array.of(1)),
        ])
        run.queue.enqueue([entry('outside.txt', Uint8Array.of(1))], '../secret')
        run.queue.enqueue([entry('passwd', Uint8Array.of(1))], '/etc')
        await flush()
        expect(run.calls).toEqual(['script.js'])
        expect(run.queue.items().find(item => item.path === 'script.js')).toMatchObject({ saved: true })
        expect(run.queue.items().filter(item => item.saved !== true).map(item => item.code).sort()).toEqual(['executable', 'executable', 'unsafe_path', 'unsafe_path', 'unsafe_path'])
    })

    it('retries a dropped writer once and then stops', async () => {
        let attempts = 0
        const run = harness(async () => {
            attempts += 1
            throw new Error('socket hang up')
        })
        run.queue.enqueue([entry('a.txt', Uint8Array.of(1))])
        await flush()
        expect(attempts).toBe(1)
        expect(run.queue.items()[0]?.status).toBe('queued')
        await run.at(1000)
        expect(attempts).toBe(2)
        expect(run.queue.items()[0]).toMatchObject({ status: 'error', saved: false, code: 'dropped' })
        await run.at(5000)
        expect(attempts).toBe(2)
    })

    it('does not auto-retry an HTTP refusal or an unconfirmed link', async () => {
        const clash = harness(async () => { throw new FilesImportWriteError('This folder already has a file named “a.txt”. The existing file was kept; rename yours and import it again.', 'clash', 409) })
        clash.queue.enqueue([entry('a.txt', Uint8Array.of(1))])
        await flush()
        await clash.at(5000)
        expect(clash.calls).toEqual(['a.txt'])
        expect(clash.queue.items()[0]).toMatchObject({ saved: false, code: 'clash' })

        const missed = harness(async () => { throw new FilesImportWriteError('The file import result could not be confirmed. Check Files before retrying.', 'unconfirmed', 500) })
        missed.queue.enqueue([entry('a.txt', Uint8Array.of(1))])
        await flush()
        await missed.at(5000)
        expect(missed.calls).toEqual(['a.txt'])
        expect(missed.queue.receipt()).toMatchObject({ savedCount: 0, failedCount: 1 })
        expect(filesImportSettlement(missed.queue.items())).toBe('Import failed')
    })

    it('retries a manual error and records progress without a socket', async () => {
        let fail = true
        const seen: number[] = []
        const run = harness(async request => {
            if (fail) throw new FilesImportWriteError('no', 'http', 415)
            request.onProgress(1, request.bytes.byteLength)
            request.onProgress(request.bytes.byteLength, request.bytes.byteLength)
            seen.push(request.bytes.byteLength)
            return { saved: true, path: request.path }
        })
        run.queue.enqueue([entry('a.txt', Uint8Array.of(7, 8))])
        await flush()
        expect(run.queue.items()[0]?.saved).toBe(false)
        fail = false
        run.queue.retry('id-1')
        await flush()
        expect(run.calls).toEqual(['a.txt', 'a.txt'])
        expect(run.queue.items()[0]).toMatchObject({ status: 'done', saved: true, progress: 1, loaded: 2 })
        expect(seen).toEqual([2])
        expect(filesImportSettlement(run.queue.items())).toBe('1 file imported')
    })

    it('removes a cancelled job and does not retry it', async () => {
        const run = harness(request => new Promise((_, reject) => {
            request.signal.addEventListener('abort', () => reject(new FilesImportWriteError('Import cancelled.', 'aborted')))
        }), 1)
        run.queue.enqueue([entry('slow.txt', Uint8Array.of(1)), entry('next.txt', Uint8Array.of(2))])
        await flush()
        expect(run.calls).toEqual(['slow.txt'])
        run.queue.cancel('id-2')
        run.queue.cancel('id-1')
        await flush()
        expect(run.calls).toEqual(['slow.txt'])
        expect(run.queue.items()).toEqual([])
        await run.at(5000)
        expect(run.calls).toEqual(['slow.txt'])
    })

    it('reloads only a confirmed save in the open folder', () => {
        expect(filesImportShouldReload('docs', { dir: 'docs', saved: true })).toBe(true)
        expect(filesImportShouldReload('docs', { dir: 'docs', saved: false })).toBe(false)
        expect(filesImportShouldReload('docs', { dir: 'other', saved: true })).toBe(false)
    })
})
