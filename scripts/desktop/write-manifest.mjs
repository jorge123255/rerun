import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopDir, resourcesDir } from './lib.mjs'
import { sourceStamp, requireStamp } from './provenance.mjs'

await mkdir(resourcesDir, { recursive: true })
const stamp = await sourceStamp()
for (const directory of [join(desktopDir, 'dist', 'main'), join(resourcesDir, 'runtime', 'ui'), join(resourcesDir, 'runtime', 'engine')]) await requireStamp(directory, stamp)
const manifest = {
    protocolVersion: 1,
    buildId: stamp.buildId,
    sourceCommit: stamp.sourceCommit,
    nodePath: 'runtime/node/bin/node',
    uiRoot: 'runtime/ui',
    engineEntry: 'runtime/engine/dist/cli/bin.js',
    uiHost: 'main/ui-host.mjs',
}
const file = join(resourcesDir, 'runtime-manifest.json')
await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${file}`)
console.log(JSON.stringify(manifest))
