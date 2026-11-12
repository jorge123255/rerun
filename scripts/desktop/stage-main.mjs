import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanDir, desktopDir, existsSync, resourcesDir } from './lib.mjs'
import { sourceStamp, writeStamp } from './provenance.mjs'

const required = [
    'index.js', 'index.mjs', 'preload.cjs', 'before-quit.mjs', 'startup.html',
    'startup.css', 'startup.js', 'startup-workspace.mjs', 'runtime.mjs', 'supervisor.mjs', 'ui-host.mjs', 'notifications.mjs', 'application-menu.mjs',
    'shell-language.mjs', ...['de', 'en', 'es', 'fr', 'pt'].map(locale => `shell-messages/${locale}.json`),
    'mac-updates.mjs', 'mac-update-signature.mjs', 'release-config.mjs',
    'mac-menu-bar.mjs', 'tray/trayTemplate.png', 'tray/trayTemplate@2x.png',
    'window-context-menu.mjs', 'displayed-image.mjs', 'board-windows.mjs',
    'connected-hub-policy.mjs', 'connected-hub-auth.mjs', 'connected-hubs.mjs', 'connected-hub-downloads.mjs',
    'connected-hub-quick-ask.mjs', 'connected-hub-service-sign-in.mjs',
    'connected-hub-recovery.mjs', 'connected-hub-messages.mjs', 'connected-hub-offline.html', 'connected-hub-offline.js',
    'connected-hub-preload.cjs', 'connected-hub.html', 'connected-hub.js', 'connected-hub.css',
    'window-find.mjs', 'find-preload.cjs', 'find.html', 'find.js', 'find.css',
    'quick-ask-window.mjs', 'quick-ask-shortcut.mjs', 'quick-ask-preload.cjs', 'quick-ask.html', 'quick-ask.js', 'quick-ask.css',
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
