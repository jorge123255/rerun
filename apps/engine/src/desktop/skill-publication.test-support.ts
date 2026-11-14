// Authored fixture only: compilation happens when root runs the tests, never at import time.
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export async function prepareSkillHelperFixture(testBarriers = false): Promise<{ path: string; close(): Promise<void> }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-skill-helper-')))
    const path = join(root, 'rename-entry')
    const source = fileURLToPath(new URL('../../../desktop/native/rename-entry.c', import.meta.url))
    try {
        const args = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', ...(testBarriers ? ['-DRERUN_RENAME_TESTING'] : []), source, '-o', path]
        await promisify(execFile)(process.platform === 'darwin' ? '/usr/bin/xcrun' : '/usr/bin/cc', process.platform === 'darwin' ? ['clang', ...args] : args,
            { timeout: 30_000, maxBuffer: 16_384 })
        return { path, close: () => rm(root, { recursive: true, force: true }) }
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
