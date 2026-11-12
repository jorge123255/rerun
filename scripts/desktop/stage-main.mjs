import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanDir, desktopDir, existsSync, resourcesDir } from './lib.mjs'
import { sourceStamp, writeStamp } from './provenance.mjs'

const required = [
    'index.js', 'index.mjs', 'preload.cjs', 'before-quit.mjs', 'startup.html',
    'startup.css', 'startup.js', 'runtime.mjs', 'supervisor.mjs', 'ui-host.mjs', 'notifications.mjs', 'application-menu.mjs',
    'mac-menu-bar.mjs', 'tray/trayTemplate.png', 'tray/trayTemplate@2x.png',
    'window-context-menu.mjs',
    'window-find.mjs', 'find-preload.cjs', 'find.html', 'find.js', 'find.css',
]

const src = join(desktopDir, 'src', 'main')
const dist = join(desktopDir, 'dist', 'main')
const stamp = await sourceStamp()
await cleanDir(dist)
await cp(src, dist, { recursive: true })
for (const file of required) {
    if (!existsSync(join(dist, file))) throw new Error(`staged main is missing ${file}`)
}
const hostTarget = join(resourcesDir, 'main')
await mkdir(hostTarget, { recursive: true })
await cp(join(src, 'ui-host.mjs'), join(hostTarget, 'ui-host.mjs'))
await writeStamp(dist, stamp)
console.log(`staged desktop main -> ${dist}`)
