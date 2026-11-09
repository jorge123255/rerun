import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { pinDesktopDataFile, verifyDesktopDataFile, type DataFilePin } from '../data-executor.ts'
import { databaseRefusal, LOGICAL_DATABASE_CAPTURE_LIMITS as BOUNDS, verifyReviewedPrivateDatabase } from './verify.ts'
import type { DesktopCoworkerShareDatabasePackage } from '@rerun/contracts'

export const privateDatabaseCaptureIdentity = z.strictObject({
    workspaceId: z.number().int().positive(), agentId: z.string().min(1).max(160),
    requestId: z.string().min(1).max(160), engineAgentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
})

export async function verifyPrivateCaptureFile(pin: DataFilePin) {
    await verifyDesktopDataFile(pin)
    if (!/[/\\]agents[/\\][A-Za-z0-9_-]+[/\\]data[/\\]agent\.db$/.test(pin.file)) return databaseRefusal('Only the canonical private coworker database may be captured.')
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const stat = await lstat(pin.file + suffix,{ bigint: true }).catch((error: NodeJS.ErrnoException) => { if (suffix && error.code === 'ENOENT') return null; throw error })
        if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(1) || stat.size > BigInt(BOUNDS.maxSourceBytes) || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) return databaseRefusal('Private database storage is unsafe or exceeds its source bound.')
    }
}

function workerLaunch() {
    const compiled = fileURLToPath(new URL('./capture-worker.js',import.meta.url))
    const execArgv = ['--max-old-space-size=128','--disable-proto=throw']
    if (existsSync(compiled)) return { file: compiled,execArgv }
    if (process.env.NODE_ENV === 'production') return databaseRefusal('The packaged private database capture worker is unavailable.')
    return { file: fileURLToPath(new URL('./capture-worker.ts',import.meta.url)), execArgv: [...execArgv,'--import',createRequire(import.meta.url).resolve('tsx')] }
}

/** Internal source preparation only; no public path, SQL, scope, grants or client is accepted. */
export async function captureScopedPrivateDatabase(input: z.infer<typeof privateDatabaseCaptureIdentity> & { engineRoot: string; signal?: AbortSignal; assertCurrent: () => Promise<void>; onWorkerSpawn?: () => void }): Promise<DesktopCoworkerShareDatabasePackage> {
    const identity = privateDatabaseCaptureIdentity.parse({ workspaceId: input.workspaceId,agentId: input.agentId,requestId: input.requestId,engineAgentId: input.engineAgentId })
    input.signal?.throwIfAborted()
    await input.assertCurrent()
    const pin = await pinDesktopDataFile(input.engineRoot,join(input.engineRoot,'agents',identity.engineAgentId,'data','agent.db'))
    await verifyPrivateCaptureFile(pin)
    await input.assertCurrent()
    input.signal?.throwIfAborted()
    const launch = workerLaunch()
    const pkg = await new Promise<DesktopCoworkerShareDatabasePackage>((resolve,reject) => {
        const child = fork(launch.file,[],{ execPath: process.execPath,execArgv: launch.execArgv,env: { NODE_ENV: 'production',TZ: 'UTC' },cwd: dirname(launch.file),stdio: ['ignore','ignore','ignore','ipc'],serialization: 'json' })
        let result: DesktopCoworkerShareDatabasePackage | undefined, failure: Error | undefined, received = false
        const stop = (reason: string) => { failure ??= new Error(reason); child.kill('SIGKILL') }
        const abort = () => stop('Private database capture canceled; no review was published.')
        const timer = setTimeout(() => stop('Private database capture exceeded its deadline.'),BOUNDS.deadlineMs)
        input.signal?.addEventListener('abort',abort,{ once: true })
        if (input.signal?.aborted) abort()
        child.on('message',(raw: unknown) => {
            if (failure) return
            try {
                if (received || Buffer.byteLength(JSON.stringify(raw)) > BOUNDS.maxEnvelopeBytes + 1024) return stop('Invalid private database capture response.')
                received = true
                const message = raw as { type?: unknown; package?: unknown }
                if (!message || message.type !== 'result') return stop('Private database capture is unavailable or unsupported; no review was published.')
                const digest = (message.package as { digest?: unknown })?.digest
                if (typeof digest !== 'string') return stop('Invalid private database capture response.')
                result = verifyReviewedPrivateDatabase(message.package,{ sourceWorkspaceId: identity.workspaceId,sourceAgentId: identity.agentId,captureRequestId: identity.requestId,expectedDigest: digest })
            } catch { stop('Private database capture failed verification; no review was published.') }
        })
        child.on('error',() => stop('Private database capture worker failed.'))
        child.on('close',code => {
            clearTimeout(timer); input.signal?.removeEventListener('abort',abort)
            if (!failure && code === 0 && result) resolve(result)
            else reject(failure ?? new Error('Private database capture stopped without a verified result.'))
        })
        try { child.send({ type: 'start',pin,identity },error => { if (error) stop('Could not start private database capture.') }) }
        catch { stop('Could not start private database capture.') }
        try { input.onWorkerSpawn?.() } catch { stop('Private database capture observer stopped.') }
    })
    input.signal?.throwIfAborted()
    await input.assertCurrent()
    await verifyPrivateCaptureFile(pin)
    input.signal?.throwIfAborted()
    return pkg
}
