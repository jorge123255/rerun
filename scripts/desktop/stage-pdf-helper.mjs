import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopDir, resourcesDir, run } from './lib.mjs'
import { macTarget } from './mac-target.mjs'
import { sourceStamp, STAMP_FILE, writeStamp } from './provenance.mjs'

if (process.platform !== 'darwin') throw new Error('The desktop PDF helper must be built on macOS')
const { clang } = macTarget()
const target = join(resourcesDir, 'runtime', 'pdf-helper')
const stamp = await sourceStamp()
await mkdir(target, { recursive: true })
await rm(join(target, STAMP_FILE), { force: true })
const output = join(target, 'rerun-render-pdf')
const temporary = `${output}.tmp`
try {
    await run('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-arch', clang, '-mmacosx-version-min=12.0', join(desktopDir, 'native', 'render-pdf.c'), '-framework', 'CoreFoundation', '-framework', 'CoreGraphics', '-framework', 'ImageIO', '-o', temporary])
    await chmod(temporary, 0o755)
    await rename(temporary, output)
    await writeStamp(target, stamp)
} finally { await rm(temporary, { force: true }) }
console.log(`staged desktop PDF helper -> ${output}`)
