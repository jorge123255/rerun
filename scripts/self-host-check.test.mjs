import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

test('quoted empty engine credentials are generated and both loopback Supabase addresses enable the relay', async () => {
    const script = fileURLToPath(new URL('./self-host-check.mjs', import.meta.url))
    for (const host of ['localhost', '127.0.0.1']) {
        const root = await mkdtemp(join(tmpdir(), 'rerun-self-host-'))
        try {
            await writeFile(join(root, '.env'), `NEXT_PUBLIC_APP_URL=http://localhost:3000\nNEXT_PUBLIC_SUPABASE_URL=http://${host}:54421\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=example-publishable\nSUPABASE_SECRET_KEY=example-service-key\nRERUN_ENGINE_API_KEY=""\n`)
            const output = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
            assert.match(output, /--profile local-supabase/)
            const env = parseEnv(await readFile(join(root, '.env'), 'utf8'))
            assert.match(env.RERUN_ENGINE_API_KEY, /^[a-f0-9]{64}$/)
            assert(!output.includes(env.RERUN_ENGINE_API_KEY))
        } finally { await rm(root, { recursive: true, force: true }) }
    }
})
