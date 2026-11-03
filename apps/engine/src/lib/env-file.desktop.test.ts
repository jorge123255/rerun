import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { readEnvFile, writeEnvFile } from './env-file.js'

afterEach(() => vi.unstubAllEnvs())

test('desktop provider credentials persist encrypted and fail closed with another installation key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-credential-'))
    const path = join(root, '.env')
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'a'.repeat(64))
    try {
        await writeEnvFile(path, { OPENAI_API_KEY: 'example-provider-secret' })
        expect(await readFile(path, 'utf8')).not.toContain('example-provider-secret')
        expect(await readEnvFile(path)).toEqual({ OPENAI_API_KEY: 'example-provider-secret' })
        vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'b'.repeat(64))
        await expect(readEnvFile(path)).rejects.toThrow()
        await writeFile(path, 'OPENAI_API_KEY=example-plaintext')
        await expect(readEnvFile(path)).rejects.toThrow('Unencrypted credentials')
    } finally { await rm(root, { recursive: true, force: true }) }
})
