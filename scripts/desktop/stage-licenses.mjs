import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cacheDir, cleanDir, existsSync, repoRoot, resourcesDir } from './lib.mjs'

const target = join(resourcesDir, 'LICENSES')
await cleanDir(target)
await cp(join(repoRoot, 'LICENSE'), join(target, 'Rerun-LICENSE.txt'))
await cp(join(repoRoot, 'TRADEMARK.md'), join(target, 'Rerun-TRADEMARK.txt'))

const thirdParty = join(target, 'third-party')
await mkdir(thirdParty, { recursive: true })

const licenseName = /^((un)?licen[cs]e|copying|notice)(\.(md|txt|rtf))?$/i
const staged = new Set()

async function isDir(path) {
    try { return (await stat(path)).isDirectory() } catch { return false }
}

async function packagesIn(nodeModulesDir) {
    const out = []
    for (const entry of await readdir(nodeModulesDir, { withFileTypes: true })) {
        const path = join(nodeModulesDir, entry.name)
        if (entry.name.startsWith('.') || !(await isDir(path))) continue
        if (entry.name.startsWith('@')) {
            for (const inner of await readdir(path)) {
                if (await isDir(join(path, inner))) out.push([`${entry.name}/${inner}`, join(path, inner)])
            }
        } else {
            out.push([entry.name, path])
        }
    }
    return out
}

async function collect(nodeModules) {
    if (!existsSync(nodeModules)) return
    const candidates = [nodeModules]
    const pnpmStore = join(nodeModules, '.pnpm')
    if (await isDir(pnpmStore)) {
        for (const id of await readdir(pnpmStore)) {
            candidates.push(join(pnpmStore, id, 'node_modules'))
        }
    }
    for (const dir of candidates) {
        if (!await isDir(dir)) continue
        for (const [name, pkgDir] of await packagesIn(dir)) {
            if (staged.has(name)) continue
            for (const file of await readdir(pkgDir).catch(() => [])) {
                if (licenseName.test(file)) {
                    await cp(join(pkgDir, file), join(thirdParty, `${name.replaceAll('/', '_')}-${file}`))
                    staged.add(name)
                    break
                }
            }
        }
    }
}

await collect(join(resourcesDir, 'runtime', 'ui', 'node_modules'))
await collect(join(resourcesDir, 'runtime', 'engine', 'node_modules'))
if (existsSync(join(cacheDir, 'Node-LICENSE.txt'))) {
    await cp(join(cacheDir, 'Node-LICENSE.txt'), join(thirdParty, 'Node.js-LICENSE.txt'))
    staged.add('Node.js')
}
console.log(`staged ${staged.size} third-party licenses -> ${thirdParty}`)
