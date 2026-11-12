import { execFile, spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { desktopDir, output, repoRoot, run } from './lib.mjs'
import { matchesSourceStamp, sourceStamp, STAMP_FILE } from './provenance.mjs'
import { macTarget } from './mac-target.mjs'

const exec = promisify(execFile)
const appID = 'build.rerun.desktop.preview'
export const bundleName = 'Rerun Desktop Preview.app'
const stageName = '.rerun-desktop-install.noindex'

export function electronAsar() {
    // Use the ASAR implementation already installed with our pinned electron-builder.
    const desktop = createRequire(join(desktopDir, 'package.json'))
    const builder = createRequire(desktop.resolve('electron-builder/package.json'))
    return createRequire(builder.resolve('app-builder-lib/package.json'))('@electron/asar')
}

async function containedFile(bundle, relativePath) {
    const file = await realpath(join(bundle, relativePath))
    if (!file.startsWith(bundle + sep)) throw new Error(`Packaged file escapes ${bundle}: ${relativePath}`)
    return file
}

async function requireIdentity(bundle) {
    if (!(await lstat(bundle)).isDirectory() || await realpath(bundle) !== bundle) throw new Error(`Refusing a linked or invalid app: ${bundle}`)
    const plist = await containedFile(bundle, 'Contents/Info.plist')
    const { stdout } = await exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist])
    if (stdout.trim() !== appID) throw new Error(`The app at ${bundle} does not have Rerun’s preview bundle ID.`)
}

export async function verifyBundle(bundle, stamp) {
    await requireIdentity(bundle)
    const json = async path => JSON.parse(await readFile(await containedFile(bundle, 'Contents/Resources/' + path), 'utf8'))
    const archive = await containedFile(bundle, 'Contents/Resources/app.asar')
    const asar = electronAsar()
    asar.uncache(archive)
    const receipts = [
        ['manifest', await json('runtime-manifest.json')],
        ['Electron shell', JSON.parse(asar.extractFile(archive, 'dist/main/' + STAMP_FILE).toString())],
        ['UI', await json('runtime/ui/' + STAMP_FILE)],
        ['engine', await json('runtime/engine/' + STAMP_FILE)],
    ]
    for (const [name, value] of receipts) {
        if (!matchesSourceStamp(value, stamp)) {
            throw new Error(`${name} receipt does not match ${stamp.sourceCommit}.`)
        }
    }
}

async function directory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if (!(await lstat(path)).isDirectory()) throw new Error(`Refusing a linked or invalid directory: ${path}`)
    return realpath(path)
}

async function existingApp(bundle) {
    let stat
    try { stat = await lstat(bundle, { bigint: true }) }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    await requireIdentity(bundle)
    return `${stat.dev}:${stat.ino}`
}

async function ensureQuit() {
    // Launch Services covers normal windows and the startup screen, before runtime.json exists.
    const { stdout } = await exec('/usr/bin/lsappinfo', ['find', 'bundleID=' + appID])
    if (stdout.trim()) throw new Error('Quit Rerun Desktop Preview and run pnpm desktop:install again.')
}

async function cleanSource() {
    const stamp = await sourceStamp()
    const untracked = await output('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoRoot })
    if (untracked) throw new Error('The install requires a clean worktree. Move or commit untracked files before building.')
    return stamp
}

async function buildInto(out, lockFD) {
    // The packaging child also owns the lock if the invoking installer exits during the build.
    await run(process.execPath, [join(repoRoot, 'scripts/desktop/package.mjs'), '--output-dir', out], {
        cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit', lockFD],
    })
}

async function publish(source, destination, replace) {
    // Darwin can exchange two nonempty directories in one syscall. The old app moves into
    // staging, so interruption never leaves the canonical path missing or half populated.
    const swap = [
        'import ctypes, os, sys',
        'rename = ctypes.CDLL(None, use_errno=True).renamex_np',
        'rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]',
        'rc = rename(os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), int(sys.argv[3]))',
        'if rc != 0: raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))',
    ].join('\n')
    await exec('/usr/bin/python3', ['-c', swap, source, destination, replace ? '2' : '4']) // RENAME_SWAP / RENAME_EXCL
}

export async function installPreview({
    applications = join(homedir(), 'Applications'), commit, stampOfSource = cleanSource,
    requireQuit = ensureQuit, build = buildInto, publishApp = publish,
} = {}) {
    if (process.platform !== 'darwin') throw new Error('The preview installer requires macOS.')
    if (commit !== undefined && !/^[a-f0-9]{40}$/.test(commit)) throw new Error('--commit requires the full 40-character Git SHA.')
    const apps = await directory(applications)
    const stage = await directory(join(apps, stageName))
    const out = join(stage, 'build')
    const destination = join(apps, bundleName)
    const lock = await open(join(stage, 'install.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
        // lockf on an inherited descriptor leaves the lock on this open file description.
        // The kernel releases it even if the process dies. Never unlink or replace the lock file.
        const result = spawnSync('/usr/bin/lockf', ['-s', '-t', '0', '3'], { stdio: ['ignore', 'ignore', 'pipe', lock.fd] })
        if (result.status === 75) throw new Error('Another Rerun preview install is in progress.')
        if (result.error || result.status !== 0) throw result.error ?? new Error('Cannot lock the preview installer.')
        // This reserved directory contains only builder output, including an old exchanged app
        // if the last process stopped just after publishing. The live app always lives outside it.
        await rm(out, { recursive: true, force: true })
        try {
            const initial = await stampOfSource()
            if (commit && initial.sourceCommit !== commit) throw new Error('The checked-out source is not the requested commit.')
            const previous = await existingApp(destination)
            await requireQuit()
            await mkdir(out, { mode: 0o700 })
            await build(out, lock.fd)
            const candidate = join(out, macTarget().appDirectory, bundleName)
            await verifyBundle(candidate, initial)
            const current = await stampOfSource()
            if (!matchesSourceStamp(current, initial)) throw new Error('The source changed during packaging.')
            await requireQuit()
            if (await existingApp(destination) !== previous) throw new Error('The installed app changed during packaging. Run the install again.')
            await publishApp(candidate, destination, previous !== undefined)
            return { destination, commit: initial.sourceCommit }
        } finally { await rm(out, { recursive: true, force: true }) }
    } finally { await lock.close() }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const args = process.argv.slice(2)
    if (args[0] === '--') args.shift()
    if (args.length && (args.length !== 2 || args[0] !== '--commit')) throw new Error('Usage: pnpm desktop:install [--commit FULL_SHA]')
    const installed = await installPreview({ commit: args[1] })
    console.log(`Installed ${installed.commit} at ${installed.destination}`)
}
