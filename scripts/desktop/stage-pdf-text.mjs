import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopDir, resourcesDir, run } from './lib.mjs'
import { macTarget } from './mac-target.mjs'
import { sourceStamp, STAMP_FILE, writeStamp } from './provenance.mjs'

if (process.platform !== 'darwin') throw new Error('The desktop PDF text helper must be built on macOS')
const { clang } = macTarget()
const target = join(resourcesDir, 'runtime', 'pdf-helper')
const stamp = await sourceStamp()
await mkdir(target, { recursive: true })
await rm(join(target, STAMP_FILE), { force: true })
const output = join(target, 'rerun-pdf-text')
const temporary = `${output}.tmp`
try {
    await run('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-O2', '-arch', clang, '-mmacosx-version-min=12.0', join(desktopDir, 'native', 'pdf-text.m'), '-framework', 'Foundation', '-framework', 'PDFKit', '-framework', 'CoreGraphics', '-o', temporary])
    await chmod(temporary, 0o755)
    await rename(temporary, output)
    await writeStamp(target, stamp)
} finally { await rm(temporary, { force: true }) }
console.log(`staged desktop PDF text helper -> ${output}`)
