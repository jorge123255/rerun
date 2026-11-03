import { chmod, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    cacheDir, existsSync, join as j, NODE_RUNTIME, nodeTarball,
    nodeTarballUrl, resourcesDir, run, sha256File,
} from './lib.mjs'

const tarball = j(cacheDir, `${nodeTarball}.tar.gz`)
await mkdir(cacheDir, { recursive: true })
if (!existsSync(tarball) || (await sha256File(tarball)) !== NODE_RUNTIME.sha256) {
    console.log(`downloading ${nodeTarballUrl}`)
    const response = await fetch(nodeTarballUrl)
    if (!response.ok) throw new Error(`Node runtime download failed: HTTP ${response.status}`)
    await writeFile(tarball, Buffer.from(await response.arrayBuffer()))
}
const digest = await sha256File(tarball)
if (digest !== NODE_RUNTIME.sha256) throw new Error(`Node runtime sha256 mismatch: ${digest}`)
console.log(`node runtime verified: ${digest}`)

const tmp = await mkdtemp(join(tmpdir(), 'rerun-node-'))
await run('tar', ['-xzf', tarball, '-C', tmp])
const unpacked = join(tmp, nodeTarball)
const target = join(resourcesDir, 'runtime', 'node')
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(join(unpacked, 'bin'), join(target, 'bin'), { recursive: true, verbatimSymlinks: true })
await cp(join(unpacked, 'lib', 'node_modules'), join(target, 'lib', 'node_modules'), { recursive: true, verbatimSymlinks: true })
await cp(join(unpacked, 'LICENSE'), join(cacheDir, 'Node-LICENSE.txt'))
await chmod(join(target, 'bin', 'node'), 0o755)
await rm(tmp, { recursive: true, force: true })
console.log(`staged node ${NODE_RUNTIME.version} -> ${target}`)
