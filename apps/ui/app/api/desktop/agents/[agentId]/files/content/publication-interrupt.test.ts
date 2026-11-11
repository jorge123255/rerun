import { spawn } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { COWORKER_PUBLISH_CRASH_STEPS } from '@/lib/desktop/server/coworker-files'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET as read } from '../read/route'
import { PUT as save } from './route'

const token = 'f'.repeat(48)
const origin = 'http://127.0.0.1:3190'
const original = '# Alice notes'
const published = 'published text'
// A crash before the draft is committed restores the previous bytes. A crash after the journal
// is marked linked keeps the published bytes. Either way the normal name exists.
const expectedText: Record<(typeof COWORKER_PUBLISH_CRASH_STEPS)[number], string> = {
    temp: original,
    prepared: original,
    renamed: original,
    uncommitted: original,
    linked: published,
}

function uiDir(): string {
    let dir = import.meta.dirname
    while (!existsSync(join(dir, 'vitest.config.ts'))) {
        const parent = dirname(dir)
        if (parent === dir) throw new Error('vitest.config.ts not found')
        dir = parent
    }
    return dir
}

function writeSynced(path: string, text: string) {
    const fd = openSync(path, 'w', 0o600)
    try {
        writeFileSync(fd, text)
        fsyncSync(fd)
    } finally { closeSync(fd) }
}

function runChild(mode: 'save' | 'read', extra: Record<string, string | undefined>) {
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
        TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, SHELL: process.env.SHELL, NODE_ENV: 'test',
        RERUN_INTERRUPT_WORKER: '1', RERUN_INTERRUPT_MODE: mode,
    }
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value
    return new Promise<{ code: number | null, signal: NodeJS.Signals | null, stderr: string }>((resolve, reject) => {
        const child = spawn(join(uiDir(), 'node_modules/.bin/vitest'), [
            'run', 'app/api/desktop/agents/[agentId]/files/content/publication-interrupt.test.ts',
            '-t', '^interrupt worker$', '--pool=forks', '--maxWorkers=1', '--fileParallelism=false',
        ], { cwd: uiDir(), env, stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
        const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }) })
    })
}

test('interrupt worker', async () => {
    if (process.env.RERUN_INTERRUPT_WORKER !== '1') return
    const mode = process.env.RERUN_INTERRUPT_MODE
    if (mode === 'save') {
        const root = await mkdtemp(join(tmpdir(), 'rerun-publish-crash-'))
        const metaPath = process.env.RERUN_INTERRUPT_META
        if (!metaPath) throw new Error('missing meta path')
        process.env.RERUN_DESKTOP_APP = '1'
        process.env.RERUN_DESKTOP_DATA_DIR = root
        process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
        await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'edit', buildId: 'edit-test', workspaceId: 1, dataRoot: root,
            app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
        const db = await openDesktopDatabase(root)
        const agent = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
        const docs = join(root, 'workspaces', '1', 'engine', 'agents', 'engine-alice', 'workspace', 'docs')
        await mkdir(docs, { recursive: true })
        await writeFile(join(docs, 'notes.md'), original)
        writeSynced(metaPath, JSON.stringify({ root, agent, docs }))
        const opened = await read(new Request(`${origin}/api/desktop/agents/${agent}/files/read?path=docs%2Fnotes.md`,
            { headers: { host: '127.0.0.1:3190', cookie: `rerun-desktop-session=${token}` } }), { params: Promise.resolve({ agentId: agent }) })
        const prev = await opened.json() as { hash?: string }
        const response = await save(new Request(`${origin}/api/desktop/agents/${agent}/files/content`, { method: 'PUT',
            headers: { host: '127.0.0.1:3190', origin, cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'docs/notes.md', content: published, baseHash: prev.hash }) }), { params: Promise.resolve({ agentId: agent }) })
        writeSynced(`${metaPath}.completed`, String(response.status))
        await closeDesktopDatabase(root)
        return
    }
    if (mode === 'read') {
        const root = process.env.RERUN_INTERRUPT_ROOT
        const agent = process.env.RERUN_INTERRUPT_AGENT
        const docs = process.env.RERUN_INTERRUPT_DOCS
        const resultPath = process.env.RERUN_INTERRUPT_RESULT
        if (!root || !agent || !docs || !resultPath) throw new Error('missing read context')
        process.env.RERUN_DESKTOP_APP = '1'
        process.env.RERUN_DESKTOP_DATA_DIR = root
        process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
        const response = await read(new Request(`${origin}/api/desktop/agents/${agent}/files/read?path=docs%2Fnotes.md`,
            { headers: { host: '127.0.0.1:3190', cookie: `rerun-desktop-session=${token}` } }), { params: Promise.resolve({ agentId: agent }) })
        const body = await response.json() as { content?: string }
        const names = await readdir(docs)
        writeSynced(resultPath, JSON.stringify({ status: response.status, content: body.content ?? null, names }))
        await closeDesktopDatabase(root)
        return
    }
    throw new Error(`unknown interrupt mode ${mode}`)
}, 20_000)

// macOS can confirm the closed inode and recover without publishing extra recovery names.
test.runIf(process.platform === 'darwin')('a new process finds the original or published file after each publication interruption', async () => {
    if (process.env.RERUN_INTERRUPT_WORKER === '1') return
    const scratch = await mkdtemp(join(tmpdir(), 'rerun-publish-meta-'))
    const seen: { step: string, status: number, content: string | null, names: string[] }[] = []
    try {
        for (const step of COWORKER_PUBLISH_CRASH_STEPS) {
            const metaPath = join(scratch, `${step}.json`)
            const resultPath = join(scratch, `${step}.result.json`)
            const crashed = await runChild('save', { RERUN_FILE_PUBLISH_CRASH: step, RERUN_INTERRUPT_META: metaPath })
            expect(existsSync(metaPath), crashed.stderr).toBe(true)
            expect(existsSync(`${metaPath}.completed`), `save finished at ${step}; crash did not run\n${crashed.stderr}`).toBe(false)
            expect(crashed.code, crashed.stderr).not.toBe(0)
            const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { root: string, agent: string, docs: string }
            const readBack = await runChild('read', {
                RERUN_INTERRUPT_ROOT: meta.root, RERUN_INTERRUPT_AGENT: meta.agent,
                RERUN_INTERRUPT_DOCS: meta.docs, RERUN_INTERRUPT_RESULT: resultPath,
            })
            expect(readBack.code, readBack.stderr).toBe(0)
            const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { status: number, content: string | null, names: string[] }
            seen.push({ step, ...result })
            expect(result.status, step).toBe(200)
            expect(result.content, step).toBe(expectedText[step])
            expect(result.names, step).toEqual(['notes.md'])
            await rm(meta.root, { recursive: true, force: true })
        }
    } finally {
        console.log('PUBLISH_INTERRUPT', JSON.stringify(seen))
        await rm(scratch, { recursive: true, force: true })
    }
}, 180_000)
