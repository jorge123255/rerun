import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { desktopCodexRuntime } from './codex-runtime.js'

// Only the authentication client lives here. Rerun's existing Codex provider owns chat turns.
export class CodexAuthClient {
    private child
    private closed = false
    private nextId = 0
    private pending = new Map<number, { receive(value: unknown): void; fail(): void }>()
    constructor(
        private notify: (method: string, params: unknown) => void,
        private exited: () => void,
    ) {
        const { codexPath, cwd, env } = desktopCodexRuntime()
        this.child = spawn(codexPath, ['app-server', '--listen', 'stdio://'], { cwd, env: { ...env, RERUN_CODEX_ACCOUNT_OP: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
        this.child.stderr.resume()
        this.child.stdin.on('error', () => this.close())
        createInterface({ input: this.child.stdout }).on('line', line => {
            let msg
            try { msg = JSON.parse(line) } catch { return }
            if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
                const pending = this.pending.get(msg.id)!
                if (msg.error) pending.fail()
                else pending.receive(msg.result)
            } else if (typeof msg.method === 'string' && msg.id === undefined) this.notify(msg.method, msg.params)
        })
        this.child.once('error', () => this.close())
        this.child.once('close', () => {
            for (const pending of this.pending.values()) pending.fail()
            this.exited()
        })
    }
    async initialize() {
        await this.request('initialize', { clientInfo: { name: 'rerun_desktop', version: '1' }, capabilities: { experimentalApi: true } })
        this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    }
    request(method: string, params: object): Promise<unknown> {
        if (this.closed) return Promise.reject(new Error('Codex sign-in process closed.'))
        const id = ++this.nextId
        return new Promise((resolve, reject) => {
            const finish = () => { clearTimeout(timer); this.pending.delete(id) }
            const fail = () => { finish(); reject(new Error(`Codex could not complete ${method}.`)) }
            // A new Mac signature can need a separate Keychain approval for the
            // bundled runner. Keep it alive long enough for the user to approve.
            const timer = setTimeout(() => {
                finish()
                reject(new Error(method === 'initialize'
                    ? 'Codex did not finish starting. If macOS is asking for Keychain access for Codex, approve that prompt and try again.'
                    : `Codex timed out while completing ${method}.`))
            }, method === 'initialize' ? 120_000 : 30_000)
            this.pending.set(id, { receive(value) { finish(); resolve(value) }, fail })
            this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) fail() })
        })
    }
    close() {
        if (this.closed) return
        this.closed = true
        this.child.stdin.end()
        this.child.kill()
    }
}
