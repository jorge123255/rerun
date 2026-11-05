import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute } from 'node:path'
import { SkillBoundaryError } from './skill-publication-error.js'

type Identity = { dev: bigint; ino: bigint }
const exec = promisify(execFile)
const env = { PATH: '/usr/bin:/bin', LANG: 'C' }
function helper(): string {
    const path = process.env.RERUN_DESKTOP_RENAME_HELPER
    if (!path || !isAbsolute(path)) throw new SkillBoundaryError(503, 'The safe Skills helper is unavailable. Reopen the app and try again.')
    return path
}

export async function renameSkillEntry(directory: string, parent: Identity, source: string, identity: Identity, destination: string): Promise<void> {
    let output: string
    try {
        output = (await exec(helper(), [directory, String(parent.dev), String(parent.ino), source, String(identity.dev), String(identity.ino), destination],
            { encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, env })).stdout
    } catch (error) {
        output = (error as { stdout?: string }).stdout ?? ''
    }
    let result: { ok?: boolean; code?: string }
    try { result = JSON.parse(output) } catch { throw new SkillBoundaryError(503, 'Could not confirm the Skills change. Reopen Skills before trying again.') }
    if (result.ok === true) return
    throw new SkillBoundaryError(result.code === 'EEXIST' || result.code === 'ESTALE' ? 409 : 503,
        'The skill changed during this operation. Existing and recovery files were preserved; reopen Skills before trying again.')
}

/** The kernel lease spans both processes and survives no process death; its file is never unlinked. */
export async function acquireSkillLease(directory: string, parent: Identity, signal?: AbortSignal): Promise<{ assertCurrent(): void; release(): Promise<void> }> {
    signal?.throwIfAborted()
    const child: ChildProcessWithoutNullStreams = spawn(helper(), ['--skill-lock', directory, String(parent.dev), String(parent.ino)], { stdio: ['pipe', 'pipe', 'pipe'], env })
    let alive = true
    let released = false
    const exited = new Promise<void>(resolve => { child.once('close', () => { alive = false; resolve() }); child.once('error', () => { alive = false; resolve() }) })
    let output = ''
    let errorBytes = 0
    const stop = () => { child.stdin.destroy(); child.kill('SIGKILL') }
    const release = async () => {
        if (released) return
        released = true
        child.stdin.end()
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
        try { await exited } finally { clearTimeout(timer) }
    }
    try {
        await new Promise<void>((resolve, reject) => {
            let settled = false
            const finish = (error?: unknown) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                signal?.removeEventListener('abort', abort)
                if (error) reject(error); else resolve()
            }
            const abort = () => { stop(); finish(signal?.reason ?? new Error('Skills operation cancelled')) }
            const timer = setTimeout(() => { stop(); finish(new SkillBoundaryError(409, 'Another Skills change is still finishing. Try again.')) }, 9000)
            child.stdout.on('data', (chunk: Buffer) => {
                output += chunk.toString('utf8')
                if (output.length > 4096) { stop(); finish(new SkillBoundaryError(503, 'Invalid Skills helper response')); return }
                if (!output.includes('\n')) return
                try {
                    const result = JSON.parse(output.trim()) as { ok?: boolean; dev?: string; ino?: string }
                    if (result.ok !== true || !/^\d+$/.test(result.dev ?? '') || !/^\d+$/.test(result.ino ?? '')) throw new Error('Not admitted')
                    finish()
                } catch { stop(); finish(new SkillBoundaryError(409, 'Could not safely lock this coworker’s skills. Try again.')) }
            })
            child.stderr.on('data', (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > 4096) { stop(); finish(new SkillBoundaryError(503, 'Skills helper failed')) } })
            child.once('error', () => finish(new SkillBoundaryError(503, 'The safe Skills helper is unavailable. Reopen the app and try again.')))
            child.once('close', () => finish(new SkillBoundaryError(409, 'Could not safely lock this coworker’s skills. Try again.')))
            child.stdin.on('error', () => {})
            signal?.addEventListener('abort', abort, { once: true })
            if (signal?.aborted) abort()
        })
        return { assertCurrent: () => { signal?.throwIfAborted(); if (!alive || released) throw new SkillBoundaryError(409, 'The Skills lock was lost. Reopen Skills before trying again.') }, release }
    } catch (error) { await release(); throw error }
}
