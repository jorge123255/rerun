import { lstat, mkdtemp, realpath, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleName } from './install.mjs'
import { run } from './lib.mjs'

export async function verifyPreviewDiskImage(image, verifyApp) {
    if (!(await lstat(image)).isFile()) throw new Error('Expected a regular preview disk image.')
    await run('/usr/bin/hdiutil', ['verify', image])
    const mount = await mkdtemp(join(await realpath(tmpdir()), 'rerun-preview-dmg-'))
    let attached = false
    try {
        await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, image])
        attached = true
        await verifyApp(join(mount, bundleName))
    } finally {
        // Never recursively delete this path. A failed detach must leave the
        // read-only volume alone and fail the package command.
        if (attached) await run('/usr/bin/hdiutil', ['detach', mount])
        await rmdir(mount)
    }
}
