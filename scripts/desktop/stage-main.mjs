import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanDir, desktopDir, existsSync } from './lib.mjs'
import { sourceStamp, writeStamp } from './provenance.mjs'

const required = [
    'index.js', 'index.mjs', 'preload.cjs', 'startup.html',
    'startup.css', 'startup.js', 'runtime.mjs', 'supervisor.mjs', 'ui-host.mjs',
]

const src = join(desktopDir, 'src', 'main')
const dist = join(desktopDir, 'dist', 'main')
const stamp = await sourceStamp()
await cleanDir(dist)
await cp(src, dist, { recursive: true })
for (const file of required) {
    if (!existsSync(join(dist, file))) throw new Error(`staged main is missing ${file}`)
}
await writeStamp(dist, stamp)
console.log(`staged desktop main -> ${dist}`)
