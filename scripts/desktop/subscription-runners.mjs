import { copyFile, mkdir, mkdtemp, realpath, lstat, chmod, rename, rm, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { existsSync, output, repoRoot, sha256File } from './lib.mjs'

// Opt-in local QA assets. An ordinary stage leaves the provider entries absent.
const runners = [
    {
        key: 'grokBuildPath', name: 'grok-build', env: 'RERUN_STAGE_GROK_BUILD',
        // grok 1.0.77 (50ca579fa996), Developer ID X.AI Corporation (5Y6N3AJ54S). Accepted by the owner on November 14, 2026.
        sha256: '197c66a63e5ac46e07450b0ca21d141ce665050a412180f185dadfae1c7a5b2a',
    },
    {
        key: 'kimiCodePath', name: 'kimi-code', env: 'RERUN_STAGE_KIMI_CODE',
        sha256: 'ae3fa721a361a2c9e9b6b3960560d1572a0bca6a8d1407e2017e6b70f80e7f97',
    },
    {
        // Devin replaces itself with each release, so no single digest stays true. It is accepted
        // when Apple's signature check says the file is intact and signed by Devin's publisher.
        key: 'devinPath', name: 'devin', env: 'RERUN_STAGE_DEVIN',
        teamId: '83Z2LHX6XW',
    },
]
const directory = engine => join(engine, 'subscription-runners')
const policyPath = engine => join(directory(engine), 'rerun-subscriptions.sb')
const loginPolicyName = 'rerun-subscription-device.sb'
const runnerPath = (engine, runner) => join(directory(engine), runner.name, 'runner')

export const requestedSubscriptionRunners = (env = process.env) => runners.some(runner => !!env[runner.env])

export async function stageSubscriptionRunners(engine, env = process.env) {
    if (!requestedSubscriptionRunners(env)) return
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
        throw new Error('The selected subscription runners require Apple silicon macOS.')
    }
    const staged = await mkdtemp(join(engine, '.subscription-runners-'))
    try {
        for (const runner of runners) {
            const source = env[runner.env]
            if (!source) continue
            if (!isAbsolute(source)) throw new Error(`Use an absolute path for the ${runner.name} runner.`)
            const actual = await realpath(source)
            if (!(await lstat(actual)).isFile()) throw new Error(`Invalid ${runner.name} runner.`)
            const target = join(staged, runner.name, 'runner')
            await mkdir(dirname(target), { mode: 0o755 })
            await copyFile(actual, target)
            await verifyRunner(target, runner)
            await chmod(target, 0o755)
        }
        const policy = await readFile(join(repoRoot, 'scripts/desktop/subscription-runner.sb'), 'utf8')
        await writeFile(join(staged, 'rerun-subscriptions.sb'), policy)
        // Devin reads its sign-in code from the terminal it is run on.
        await writeFile(join(staged, loginPolicyName), policy +
            '\n(allow network-outbound (remote ip (param "AUTH_RELAY")))\n' +
            '(allow file-read* file-write-data file-ioctl (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))\n' +
            // Devin checks each server's certificate with the Mac's own trust service. Without it every
            // secure connection failed, the sign-in fell back to another route and the code was refused.
            '(allow mach-lookup (global-name "com.apple.trustd.agent") (global-name "com.apple.trustd") (global-name "com.apple.ocspd") (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))\n' +
            '(allow file-read* (literal "/Library/Keychains/System.keychain") (subpath "/private/var/db/mds") (literal "/Library/Preferences/com.apple.security.plist") (regex #"^/Library/Preferences/com\\.apple\\.security\\..*\\.plist$"))\n' +
            '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center") (ipc-posix-name-regex #"^com\\.apple\\.AppleDatabaseChanged"))\n')
        await rename(staged, directory(engine))
    } finally {
        await rm(staged, { recursive: true, force: true })
    }
}

async function verifyRunner(path, runner) {
    if (!(await lstat(path)).isFile()) throw new Error(`Invalid ${runner.name} runner.`)
    if (runner.teamId) {
        if (!/^[A-Z0-9]{10}$/.test(runner.teamId)) throw new Error(`Invalid ${runner.name} publisher.`)
        try {
            await output('/usr/bin/codesign', ['--verify', '--strict', `-R=anchor apple generic and certificate leaf[subject.OU] = "${runner.teamId}"`, path])
        } catch {
            throw new Error(`The ${runner.name} runner is not signed by its publisher.`)
        }
        return
    }
    if (await sha256File(path) !== runner.sha256) {
        throw new Error(`The ${runner.name} runner does not match the reviewed arm64 asset.`)
    }
}

export async function stagedSubscriptionManifest(engine, resources) {
    const manifest = {}
    for (const runner of runners) {
        const path = runnerPath(engine, runner)
        if (!existsSync(path)) continue
        await verifyRunner(path, runner)
        manifest[runner.key] = relative(resources, path)
    }
    if (Object.keys(manifest).length) {
        if (!(await lstat(policyPath(engine))).isFile()) throw new Error('Invalid subscription runner policy.')
        manifest.subscriptionSandboxPath = relative(resources, policyPath(engine))
        const loginPolicy = join(directory(engine), loginPolicyName)
        if (!(await lstat(loginPolicy)).isFile()) throw new Error('Invalid subscription device sign-in policy.')
        manifest.subscriptionLoginSandboxPath = relative(resources, loginPolicy)
    }
    return manifest
}
