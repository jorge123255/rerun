import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopDir, resourcesDir, run } from './lib.mjs'
import { macTarget } from './mac-target.mjs'
import { sourceStamp, writeStamp } from './provenance.mjs'

if (process.platform !== 'darwin') throw new Error('The desktop file helper must be built on macOS')
const { clang } = macTarget()
const target = join(resourcesDir, 'runtime', 'helpers')
const stamp = await sourceStamp()
await mkdir(target, { recursive: true })
const output = join(target, 'rerun-rename-entry')
await run('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-arch', clang, '-mmacosx-version-min=12.0', join(desktopDir, 'native', 'rename-entry.c'), '-o', output])
await chmod(output, 0o755)
await writeStamp(target, stamp)
console.log(`staged desktop file helper -> ${output}`)
