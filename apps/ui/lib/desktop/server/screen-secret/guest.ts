import 'server-only'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

// The app's own small door to a coworker's screen, used only to type a saved secret. It mirrors the
// engine's isolated-screen code (docker-cli, docker-args, frame) rather than importing it: those
// files name their neighbours with a .js ending, which the app's production build cannot follow.

const CONTAINER = /^rerun-screen-[a-z0-9]{8,64}$/
const JSON_MAX = 1_000_000

export type ScreenGuest = {
    /** State and labels of the container, or null when it is absent or Docker cannot be reached. */
    inspect(name: string, signal: AbortSignal): Promise<{ state: string; labels: Record<string, string> } | null>
    /** One request to the screen's own program. The request travels on stdin, never on the command line. */
    call(name: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>
}

export function encodeGuestFrame(value: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(value))
    if (body.length > JSON_MAX) throw new Error('Screen request is too large')
    const header = Buffer.alloc(8)
    header.writeUInt32BE(body.length, 0)
    header.writeUInt32BE(0, 4)
    return Buffer.concat([header, body])
}

export function decodeGuestFrame(blob: Buffer): Record<string, unknown> {
    if (blob.length < 8) throw new Error('Screen reply was cut off')
    const jsonLength = blob.readUInt32BE(0), binaryLength = blob.readUInt32BE(4)
    if (jsonLength > JSON_MAX || blob.length !== 8 + jsonLength + binaryLength) throw new Error('Screen reply is malformed')
    const value: unknown = JSON.parse(blob.subarray(8, 8 + jsonLength).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Screen reply is malformed')
    return value as Record<string, unknown>
}

function docker(): string {
    const app = '/Applications/Docker.app/Contents/Resources/bin/docker'
    return process.platform === 'darwin' && existsSync(app) ? app : 'docker'
}

function run(args: string[], signal: AbortSignal, input?: Buffer): Promise<{ code: number | null; stdout: Buffer }> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
        const child = spawn(docker(), args, { shell: false, stdio: ['pipe', 'pipe', 'ignore'] })
        const out: Buffer[] = []
        let size = 0
        const stop = () => child.kill('SIGKILL')
        signal.addEventListener('abort', stop, { once: true })
        child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > JSON_MAX + 4096) stop(); else out.push(chunk) })
        child.once('error', error => { signal.removeEventListener('abort', stop); reject(error) })
        child.once('close', code => {
            signal.removeEventListener('abort', stop)
            if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'))
            else resolve({ code, stdout: Buffer.concat(out) })
        })
        child.stdin.on('error', () => {})
        child.stdin.end(input)
    })
}

export function createScreenGuest(): ScreenGuest {
    return {
        async inspect(name, signal) {
            if (!CONTAINER.test(name)) return null
            const result = await run(['inspect', '--format', '{{.State.Status}}\t{{json .Config.Labels}}', '--', name], signal).catch(() => null)
            if (!result || result.code !== 0) return null
            const text = result.stdout.toString('utf8').trim(), tab = text.indexOf('\t')
            if (tab <= 0) return null
            try {
                const labels: unknown = JSON.parse(text.slice(tab + 1))
                if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return null
                return { state: text.slice(0, tab), labels: Object.fromEntries(Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) }
            } catch { return null }
        },
        async call(name, body, signal) {
            if (!CONTAINER.test(name)) throw new Error('Not a coworker screen')
            const result = await run(['exec', '-i', '--', name, 'rerun-rpc'], signal, encodeGuestFrame(body))
            if (result.code !== 0) throw new Error('Screen request failed')
            return decodeGuestFrame(result.stdout)
        },
    }
}
