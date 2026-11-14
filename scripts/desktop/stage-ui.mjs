import { cp, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { buildId, existsSync, flag, pnpm, repoRoot, resourcesDir } from './lib.mjs'
import { sourceStamp, stampMatches, writeStamp } from './provenance.mjs'
import { stageUiSharp } from './ui-sharp.mjs'
import { macTarget } from './mac-target.mjs'

const uiDir = join(repoRoot, 'apps', 'ui')
const standalone = join(uiDir, '.next', 'standalone')
const stamp = await sourceStamp()

if (flag('--build') || !existsSync(standalone) || !await stampMatches(join(uiDir, '.next'), stamp)) {
    const env = {
        ...process.env,
        RERUN_DESKTOP_STANDALONE: '1',
        NEXT_TELEMETRY_DISABLED: '1',
        NEXT_PUBLIC_BUILD_SHA: await buildId(),
        NEXT_PUBLIC_APP_URL: 'http://127.0.0.1',
    }
    await pnpm(['--filter', '@rerun/contracts', 'exec', 'tsc', '--build', '--force'])
    await pnpm(['--filter', 'rerun', 'build'], { env })
    await writeStamp(join(uiDir, '.next'), stamp)
}
if (!existsSync(standalone)) throw new Error(`Next standalone output missing: ${standalone}`)

async function findServerRoot(dir, depth = 0) {
    if (depth > 4) return null
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isFile() && entry.name === 'server.js') return dir
        if (entry.isDirectory() && !['node_modules', '.next'].includes(entry.name)) {
            const found = await findServerRoot(path, depth + 1).catch(() => null)
            if (found) return found
        }
    }
    return null
}

const appRoot = await findServerRoot(standalone)
if (!appRoot) throw new Error(`no server.js under ${standalone}`)
console.log(`standalone app root: ${relative(standalone, appRoot) || '.'}`)

const uiRoot = join(resourcesDir, 'runtime', 'ui')
await rm(uiRoot, { recursive: true, force: true })
await mkdir(uiRoot, { recursive: true })
await cp(appRoot, uiRoot, { recursive: true, verbatimSymlinks: true })
await cp(join(standalone, 'node_modules'), join(uiRoot, 'node_modules'), { recursive: true, verbatimSymlinks: true })
await cp(join(uiDir, '.next', 'static'), join(uiRoot, '.next', 'static'), { recursive: true, verbatimSymlinks: true })
await cp(join(uiDir, 'public'), join(uiRoot, 'public'), { recursive: true, verbatimSymlinks: true })

// The standalone tree nests the app at apps/ui; flattening to uiRoot shifts every
// node_modules link up one directory. Links that now resolve outside uiRoot are
// re-pointed at the matching tail inside uiRoot/node_modules.
async function relinkEscaped(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await relinkEscaped(path)
        } else if (entry.isSymbolicLink()) {
            const target = resolve(dirname(path), await readlink(path))
            if (relative(uiRoot, target).startsWith('..')) {
                const marker = `${sep}node_modules${sep}`
                const tail = target.slice(target.indexOf(marker) + marker.length)
                const remapped = join(uiRoot, 'node_modules', tail)
                if (!existsSync(remapped)) throw new Error(`staged link escapes and cannot be remapped: ${path} -> ${target}`)
                await rm(path)
                await symlink(relative(dirname(path), remapped), path)
            }
        }
    }
}
await relinkEscaped(uiRoot)
const sharp = await stageUiSharp({ uiDir, uiRoot, sourceNodeModules: join(repoRoot, 'node_modules'), platform: macTarget().platform })
console.log(`staged complete UI Sharp ${sharp.version} dependency graph (${sharp.aliases.join(', ')})`)
await writeStamp(uiRoot, stamp)
if (!existsSync(join(uiRoot, 'server.js'))) throw new Error('staged UI is missing server.js')
console.log(`staged ui -> ${uiRoot}`)
