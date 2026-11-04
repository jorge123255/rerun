import { cp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

export const UI_SHARP_MANIFEST = 'desktop-ui-sharp.json'
const aliasName = /^sharp-[a-z0-9]+$/
const within = (root, path) => {
    const rel = relative(root, path)
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
const metadata = async root => JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

// Resolve installed package directories without loading their native code. Some @img packages
// export './package', not './package.json', and have no default entry point at all.
async function installedPackage(from, name) {
    for (const modules of createRequire(join(from, 'package.json')).resolve.paths(name) ?? []) {
        const location = join(modules, name)
        try {
            const root = await realpath(location)
            const pkg = await metadata(root)
            if (pkg.name !== name) throw new Error(`Unexpected package at ${location}`)
            return { root, location, pkg }
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
        }
    }
    return null
}

async function replaceLink(path, target) {
    if (path === target) return
    await mkdir(dirname(path), { recursive: true })
    await rm(path, { recursive: true, force: true })
    await symlink(relative(dirname(path), target), path)
}

/** Restore the UI's own installed Sharp graph, never the engine's different Sharp version.
 * Next's trace can contain a native package's metadata while omitting its dylib and adjacent
 * @img link. Copy complete runtime packages and reconstruct the exact installed resolution edges.
 */
export async function stageUiSharp({ uiDir, uiRoot, sourceNodeModules, platform = 'darwin-arm64' }) {
    const sourceRoot = await realpath(sourceNodeModules)
    const targetRoot = await realpath(uiRoot)
    const sharp = await installedPackage(uiDir, 'sharp')
    if (!sharp) throw new Error('The installed UI Sharp dependency is missing')
    const mirror = path => {
        if (!within(sourceRoot, path)) throw new Error(`Sharp dependency escapes installed node_modules: ${path}`)
        return join(targetRoot, 'node_modules', relative(sourceRoot, path))
    }
    mirror(sharp.root)

    const aliasDir = join(targetRoot, '.next', 'node_modules')
    const aliases = []
    for (const entry of await readdir(aliasDir)) {
        if (!aliasName.test(entry)) continue
        const root = await realpath(join(aliasDir, entry))
        if (!within(targetRoot, root)) throw new Error(`UI Sharp alias escapes staging: ${entry}`)
        const pkg = await metadata(root)
        if (pkg.name === 'sharp' && pkg.version === sharp.pkg.version) aliases.push(entry)
    }
    if (!aliases.length) throw new Error(`No traced UI Sharp alias matches installed version ${sharp.pkg.version}`)

    // These optional dependencies are mandatory for the packaged Mac target. Keep their exact
    // installed versions, including the native addon's own adjacent libvips dependency edge.
    for (const name of [`@img/sharp-${platform}`, `@img/sharp-libvips-${platform}`]) {
        const dependency = await installedPackage(sharp.root, name)
        const expected = sharp.pkg.optionalDependencies?.[name]
        if (!dependency || !expected || dependency.pkg.version !== expected) throw new Error(`Missing or mismatched UI Sharp native dependency: ${name}`)
    }

    const copied = new Map()
    async function copyPackage(source) {
        const target = mirror(source.root)
        if (copied.has(source.root)) return target
        copied.set(source.root, { name: source.pkg.name, version: source.pkg.version, path: relative(targetRoot, target) })
        await mkdir(dirname(target), { recursive: true })
        await rm(target, { recursive: true, force: true })
        await cp(source.root, target, { recursive: true, verbatimSymlinks: true })
        const required = source.pkg.dependencies ?? {}
        const optional = source.pkg.optionalDependencies ?? {}
        for (const name of Object.keys({ ...required, ...optional })) {
            const child = await installedPackage(source.root, name)
            if (!child) {
                if (!(name in optional)) throw new Error(`Missing installed Sharp dependency: ${source.pkg.name} -> ${name}`)
                continue
            }
            if (name.startsWith('@img/sharp-') && optional[name] && child.pkg.version !== optional[name]) {
                throw new Error(`Mismatched installed Sharp dependency: ${source.pkg.name} -> ${name}`)
            }
            const childTarget = await copyPackage(child)
            await replaceLink(mirror(child.location), childTarget)
        }
        return target
    }
    const sharpTarget = await copyPackage(sharp)
    await replaceLink(join(targetRoot, 'node_modules', 'sharp'), sharpTarget)
    for (const alias of aliases) await replaceLink(join(aliasDir, alias), sharpTarget)

    // Reject dangling or escaping links inside copied packages before recording the graph.
    async function checkLinks(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name)
            if (entry.isSymbolicLink()) {
                const target = await realpath(path)
                if (!within(targetRoot, target)) throw new Error(`Sharp runtime link escapes staging: ${path}`)
            } else if (entry.isDirectory()) await checkLinks(path)
        }
    }
    for (const item of copied.values()) {
        const packageRoot = join(targetRoot, item.path)
        await checkLinks(packageRoot)
        // Dependency links are siblings of a package in pnpm, not children of its package root.
        const modules = item.name.startsWith('@') ? dirname(dirname(packageRoot)) : dirname(packageRoot)
        await checkLinks(modules)
    }
    const manifest = { version: sharp.pkg.version, aliases: aliases.sort(), packages: [...copied.values()] }
    await writeFile(join(targetRoot, UI_SHARP_MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
    return manifest
}

/** Verify recorded aliases remain contained and point at the exact UI version before probing. */
export async function readUiSharpManifest(uiRoot) {
    const root = await realpath(uiRoot)
    const manifest = JSON.parse(await readFile(join(root, UI_SHARP_MANIFEST), 'utf8'))
    if (typeof manifest.version !== 'string' || !Array.isArray(manifest.aliases) || !manifest.aliases.length) throw new Error('Missing UI Sharp alias metadata')
    for (const alias of manifest.aliases) {
        if (typeof alias !== 'string' || !aliasName.test(alias)) throw new Error('Invalid UI Sharp alias')
        const target = await realpath(join(root, '.next', 'node_modules', alias))
        if (!within(root, target)) throw new Error('UI Sharp alias escapes staging')
        const pkg = await metadata(target)
        if (pkg.name !== 'sharp' || pkg.version !== manifest.version) throw new Error('Staged UI Sharp version changed')
    }
    return manifest
}
