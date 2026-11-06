import { cp, mkdir, mkdtemp, rm, chmod, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { existsSync, flag, pnpm, resourcesDir, repoRoot } from './lib.mjs'
import { sourceStamp, stampMatches, writeStamp } from './provenance.mjs'

const target = join(resourcesDir, 'runtime', 'engine')
const dist = join(repoRoot, 'apps', 'engine', 'dist')
const stamp = await sourceStamp()

if (flag('--build') || !existsSync(join(dist, 'cli', 'bin.js')) || !await stampMatches(dist, stamp)) {
    await pnpm(['--filter', '@rerun/contracts', 'exec', 'tsc', '--build', '--force'])
    // Never let a changed compiler output layout leave a stale runnable entry behind.
    // rootDir pins the layout; a clean build makes the entry check prove this compile.
    await rm(dist, { recursive: true, force: true })
    await pnpm(['--filter', 'rerun-engine', 'build'])
    if (!existsSync(join(dist, 'cli', 'bin.js'))) throw new Error('engine build did not produce dist/cli/bin.js')
    await writeStamp(dist, stamp)
}
const deploy = await mkdtemp(join(tmpdir(), 'rerun-engine-deploy-'))
try {
    await pnpm(['--filter', 'rerun-engine', 'deploy', '--prod', deploy])
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await cp(deploy, target, { recursive: true, verbatimSymlinks: true })
} finally {
    await rm(deploy, { recursive: true, force: true })
}
if (!existsSync(join(target, 'dist', 'cli', 'bin.js'))) throw new Error('staged engine is missing dist/cli/bin.js')
await cp(join(repoRoot, 'apps', 'engine', 'desktop-guest'), join(target, 'desktop-guest'), { recursive: true })
// Resolve the platform package through the lockfile's installed dependencies, never PATH.
const engineRequire = createRequire(join(target, 'package.json'))
const adapter = createRequire(engineRequire.resolve('ai-sdk-provider-codex-cli'))
const codex = createRequire(adapter.resolve('@openai/codex/package.json'))
const platform = dirname(codex.resolve('@openai/codex-darwin-arm64/package.json'))
const bin = dirname(await realpath(join(platform, 'vendor/aarch64-apple-darwin/bin/codex')))
const host = await realpath(join(bin, 'codex-code-mode-host'))
if (dirname(host) !== bin) throw new Error('Codex tool host is outside its packaged bin directory')
if (relative(target, bin).startsWith('..')) throw new Error('Codex executable escapes the staged engine')
await cp(join(repoRoot, 'scripts/desktop/codex-launcher.sh'), join(bin, 'rerun-codex'))
await chmod(join(bin, 'rerun-codex'), 0o755)
await cp(join(repoRoot, 'scripts/desktop/codex-launcher.sb'), join(bin, 'rerun-codex.sb'))
await cp(join(repoRoot, 'scripts/desktop/native-worker.sb'), join(bin, 'rerun-native-worker.sb'))
const claudeAdapter = createRequire(engineRequire.resolve('ai-sdk-provider-claude-code'))
const claudeSdk = createRequire(claudeAdapter.resolve('@anthropic-ai/claude-agent-sdk'))
const claudePlatform = dirname(claudeSdk.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json'))
const claudeBinary = await realpath(join(claudePlatform, 'claude'))
if (relative(target, claudeBinary).startsWith('..')) throw new Error('Claude executable escapes the staged engine')
await cp(join(repoRoot, 'scripts/desktop/claude-runner.sb'), join(claudePlatform, 'rerun-claude.sb'))
await writeStamp(target, stamp)
console.log(`staged engine -> ${target}`)
