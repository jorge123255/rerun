import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, flag, pnpm, resourcesDir } from './lib.mjs'

const target = join(resourcesDir, 'runtime', 'engine')

if (flag('--build') || !existsSync(target)) {
    await pnpm(['--filter', '@rerun/contracts', 'build'])
    await pnpm(['--filter', 'rerun-engine', 'build'])
}
const deploy = await mkdtemp(join(tmpdir(), 'rerun-engine-deploy-'))
try {
    await pnpm(['--filter', 'rerun-engine', 'deploy', '--prod', deploy])
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await cp(deploy, target, { recursive: true, verbatimSymlinks: true })
} finally {
    await rm(deploy, { recursive: true, force: true })
}
if (!existsSync(join(target, 'dist', 'cli', 'bin.js'))) throw new Error('staged engine is missing dist/cli/bin.js')
console.log(`staged engine -> ${target}`)
