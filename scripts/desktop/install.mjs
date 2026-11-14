import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { desktopDir, output, repoRoot, run } from './lib.mjs'
import { matchesSourceStamp, sourceStamp, STAMP_FILE } from './provenance.mjs'
import { macTarget } from './mac-target.mjs'
import { verifyPackagedElectron } from './verify-electron.mjs'

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

async function bundleReceipt(bundle, path) {
    return JSON.parse(await readFile(await containedFile(bundle, 'Contents/Resources/' + path), 'utf8'))
}

export async function verifyBundle(bundle, stamp) {
    await requireIdentity(bundle)
    const archive = await containedFile(bundle, 'Contents/Resources/app.asar')
    const asar = electronAsar()
    asar.uncache(archive)
    const receipts = [
        ['manifest', await bundleReceipt(bundle, 'runtime-manifest.json')],
        ['Electron shell', JSON.parse(asar.extractFile(archive, 'dist/main/' + STAMP_FILE).toString())],
        ['UI', await bundleReceipt(bundle, 'runtime/ui/' + STAMP_FILE)],
        ['engine', await bundleReceipt(bundle, 'runtime/engine/' + STAMP_FILE)],
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

async function installFromImage({ image, sha256, commit, out, candidate, destination, previous, lockFD }) {
    if (!(await lstat(image)).isFile()) throw new Error('Expected a regular preview disk image.')
    const snapshot = join(out, 'preview.dmg')
    await copyFile(image, snapshot, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(snapshot)) hash.update(chunk)
    if (hash.digest('hex') !== sha256) throw new Error('Preview disk image SHA-256 does not match.')

    let requirement = `identifier "${appID}" and anchor apple generic`
    if (previous) {
        const { stdout } = await exec('/usr/bin/codesign', ['-d', '-r-', destination])
        const designated = stdout.match(/^designated => (.+)$/m)?.[1]
        if (!designated) throw new Error('Could not read the installed preview’s signing requirement.')
        requirement += ` and (${designated})`
    }
    const { verifyPreviewDiskImage } = await import('./preview-disk-image.mjs')
    await verifyPreviewDiskImage(snapshot, async mounted => {
        await requireIdentity(mounted)
        await mkdir(join(out, macTarget().appDirectory))
        await run('/usr/bin/ditto', [mounted, candidate], { stdio: ['ignore', 'inherit', 'inherit', lockFD] })
    })
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', `=${requirement}`, candidate])
    await verifyPackagedElectron(candidate)
    const stamp = await bundleReceipt(candidate, 'runtime-manifest.json')
    if (stamp?.protocolVersion !== 1 || stamp.sourceCommit !== commit || stamp.arch !== macTarget().arch
        || typeof stamp.buildId !== 'string' || !stamp.buildId) {
        throw new Error('The disk image does not contain the requested preview commit and Mac architecture.')
    }
    await verifyBundle(candidate, stamp)
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
    applications = join(homedir(), 'Applications'), commit, image, sha256, stampOfSource = cleanSource,
    requireQuit = ensureQuit, build = buildInto, publishApp = publish,
} = {}) {
    if (process.platform !== 'darwin') throw new Error('The preview installer requires macOS.')
    if (commit !== undefined && !/^[a-f0-9]{40}$/.test(commit)) throw new Error('--commit requires the full 40-character Git SHA.')
    if (image !== undefined && (!image || !commit || !/^[a-f0-9]{64}$/.test(sha256 ?? ''))) {
        throw new Error('--dmg requires --commit with a full Git SHA and --sha256 with the verified image digest.')
    }
    if (image === undefined && sha256 !== undefined) throw new Error('--sha256 requires --dmg.')
    // Resolve before creating or clearing installer staging. An image in that staging directory is not an input.
    const imagePath = image === undefined ? undefined : resolve(image)
    const apps = await directory(applications)
    const stage = await directory(join(apps, stageName))
    if (imagePath && (imagePath.startsWith(stage + sep) || (await realpath(imagePath)).startsWith(stage + sep))) {
        throw new Error('Use a disk image outside the preview installer’s staging directory.')
    }
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
            const initial = imagePath ? null : await stampOfSource()
            if (initial && commit && initial.sourceCommit !== commit) throw new Error('The checked-out source is not the requested commit.')
            const previous = await existingApp(destination)
            await requireQuit()
            await mkdir(out, { mode: 0o700 })
            const candidate = join(out, macTarget().appDirectory, bundleName)
            if (imagePath) {
                await installFromImage({ image: imagePath, sha256, commit, out, candidate, destination, previous, lockFD: lock.fd })
            } else {
                await build(out, lock.fd)
                await verifyBundle(candidate, initial)
                if (!matchesSourceStamp(await stampOfSource(), initial)) throw new Error('The source changed during packaging.')
            }
            await requireQuit()
            if (await existingApp(destination) !== previous) throw new Error('The installed app changed during packaging. Run the install again.')
            await publishApp(candidate, destination, previous !== undefined)
            return { destination, commit: initial?.sourceCommit ?? commit }
        } finally { await rm(out, { recursive: true, force: true }) }
    } finally { await lock.close() }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const args = process.argv.slice(2)
    if (args[0] === '--') args.shift()
    const names = new Map([['--commit', 'commit'], ['--dmg', 'image'], ['--sha256', 'sha256']])
    const options = {}
    for (let i = 0; i < args.length; i += 2) {
        const key = names.get(args[i])
        if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) {
            throw new Error('Usage: pnpm desktop:install [--commit FULL_SHA] or pnpm desktop:install --dmg IMAGE --commit FULL_SHA --sha256 DIGEST')
        }
        options[key] = args[i + 1]
    }
    const installed = await installPreview(options)
    console.log(`Installed ${installed.commit} at ${installed.destination}`)
}
