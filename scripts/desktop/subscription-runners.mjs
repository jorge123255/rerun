import { copyFile, mkdir, mkdtemp, realpath, lstat, chmod, rename, rm, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { existsSync, repoRoot, sha256File } from './lib.mjs'

// Opt-in local QA assets. An ordinary stage leaves the provider entries absent.
const runners = [
    {
        key: 'grokBuildPath', name: 'grok-build', env: 'RERUN_STAGE_GROK_BUILD',
        sha256: '5c8a688251bf61e35370b828b6a353b0a20fcc3f64000de8a91d426039f29cec',
    },
    {
        key: 'kimiCodePath', name: 'kimi-code', env: 'RERUN_STAGE_KIMI_CODE',
        sha256: 'ae3fa721a361a2c9e9b6b3960560d1572a0bca6a8d1407e2017e6b70f80e7f97',
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
        await writeFile(join(staged, loginPolicyName), policy +
            '\n(allow network-outbound (remote ip (param "AUTH_RELAY")))\n')
        await rename(staged, directory(engine))
    } finally {
        await rm(staged, { recursive: true, force: true })
    }
}

async function verifyRunner(path, runner) {
    if (!(await lstat(path)).isFile() || await sha256File(path) !== runner.sha256) {
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
