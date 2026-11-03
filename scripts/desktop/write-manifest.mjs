import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildId, resourcesDir } from './lib.mjs'

await mkdir(resourcesDir, { recursive: true })
const manifest = {
    protocolVersion: 1,
    buildId: await buildId(),
    nodePath: 'runtime/node/bin/node',
    uiRoot: 'runtime/ui',
    engineEntry: 'runtime/engine/dist/cli/bin.js',
}
const file = join(resourcesDir, 'runtime-manifest.json')
await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${file}`)
console.log(JSON.stringify(manifest))
