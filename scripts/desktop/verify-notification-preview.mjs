import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyBundle } from './install.mjs'
import { run } from './lib.mjs'
import { sourceStamp } from './provenance.mjs'

export async function verifyNotificationPreview(bundle, stamp) {
    if (!isAbsolute(bundle)) throw new Error('Use the absolute path to the signed Rerun Desktop Preview.app.')
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict',
        '--test-requirement', '=identifier "build.rerun.desktop.preview" and anchor apple generic', bundle])
    await verifyBundle(bundle, stamp)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const [bundle, ...extra] = process.argv.slice(2)
    if (!bundle || extra.length) throw new Error('Usage: node scripts/desktop/verify-notification-preview.mjs /absolute/path/to/Rerun Desktop Preview.app')
    const stamp = await sourceStamp()
    await verifyNotificationPreview(bundle, stamp)
    console.log(`Signed notification QA bundle verified for ${stamp.sourceCommit}.`)
}
