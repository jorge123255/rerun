import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, flag, pnpm, resourcesDir, repoRoot } from './lib.mjs'
import { sourceStamp, stampMatches, writeStamp } from './provenance.mjs'

const target = join(resourcesDir, 'runtime', 'engine')
const dist = join(repoRoot, 'apps', 'engine', 'dist')
const stamp = await sourceStamp()

if (flag('--build') || !existsSync(join(dist, 'cli', 'bin.js')) || !await stampMatches(dist, stamp)) {
    await pnpm(['--filter', '@rerun/contracts', 'build'])
    await pnpm(['--filter', 'rerun-engine', 'build'])
    await writeStamp(dist, stamp)
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
await writeStamp(target, stamp)
console.log(`staged engine -> ${target}`)
