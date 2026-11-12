import { mkdir, mkdtemp, rm, readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir, userInfo } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { loadBundle } from '../../apps/desktop/src/main/runtime.mjs'
import { existsSync, output, repoRoot, resourcesDir } from './lib.mjs'
import { readUiSharpManifest } from './ui-sharp.mjs'
import { verifyPdfHelper } from './pdf-helper-probe.mjs'
import { verifyPdfTextHelper } from './pdf-text-probe.mjs'
import { runtimeSymlinkIsContained } from './runtime-symlinks.mjs'
import { macTarget, nodeVersion } from './mac-target.mjs'

const execFileAsync = promisify(execFile)
const failures = []
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures.push(label) }
function refuseFailures() {
    if (!failures.length) return
    console.error(`\n${failures.length} verification failure(s)`)
    process.exit(1)
}

const root = await realpath(resourcesDir)
const forbidden = /^(?:\.env(?:$|\.)|\.(?:git|svn|hg)$)/i
const secretExt = /\.(pem|key|p12|pfx|mobileprovision|jks|keystore)$/i
const offenders = []
const escapees = []
async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (forbidden.test(entry.name) || secretExt.test(entry.name)) offenders.push(path)
        else if (entry.isDirectory()) await scan(path)
        else if (entry.isSymbolicLink() && !await runtimeSymlinkIsContained(root, path)) escapees.push(path)
    }
}
await scan(root)
check(offenders.length === 0, `no secrets/vcs files staged${offenders.length ? ` (${offenders.join(', ')})` : ''}`)
check(escapees.length === 0, `all symlinks can relocate inside resources${escapees.length ? ` (${escapees.join(', ')})` : ''}`)
refuseFailures()

// Use the same manifest rules as startup, and finish the static checks before
// executing or resolving modules from any part of the staged runtime.
const resolved = await loadBundle(root)
check(true, 'manifest protocolVersion/buildId and contained runtime paths')
const engineDir = join(root, 'runtime', 'engine')
const uiDir = resolved.uiRoot
check(resolved.engineEntry === join(engineDir, 'dist', 'cli', 'bin.js'), 'manifest engine entry matches the staged runtime')
check(existsSync(join(uiDir, 'server.js')), 'manifest UI server.js staged')
check(!['components', 'test'].some(dir => existsSync(join(uiDir, dir))), 'compiled UI ships without source components or test fixtures')
check(existsSync(join(uiDir, '.next', 'static')), 'ui .next/static staged')
check(existsSync(join(uiDir, 'public')), 'ui public staged')
check(existsSync(join(root, 'runtime', 'node', 'bin', 'npm')) || existsSync(join(root, 'runtime', 'node', 'lib', 'node_modules', 'npm')), 'bundled npm staged')
refuseFailures()

const { arch, clang } = macTarget()
const manifest = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8'))
check(manifest.arch === arch, `manifest targets ${arch}`)
for (const [name, path] of [
    ['Node', resolved.nodePath],
    ['Codex', join(dirname(resolved.codexPath), 'codex')],
    ['Codex code mode host', join(dirname(resolved.codexPath), 'codex-code-mode-host')],
    ['Claude', resolved.claudePath],
    ['File helper', resolved.renameHelperPath],
    ['PDF renderer', resolved.pdfHelperPath],
    ['PDF text helper', resolved.pdfTextHelperPath],
]) {
    const nativeArch = await output('/usr/bin/lipo', ['-archs', path]).catch(() => 'unverified')
    check(nativeArch === clang, `${name} targets ${clang} (${nativeArch})`)
}
refuseFailures()
const bundledNodeVersion = await output(resolved.nodePath, ['--version']).catch(error => `error: ${error.message}`)
check(bundledNodeVersion === nodeVersion, `bundled node runs (${bundledNodeVersion})`)

try {
    await verifyPdfHelper(resolved.pdfHelperPath)
    check(true, 'native PDF helper renders a bounded PNG through the manifest path')
} catch {
    check(false, 'native PDF helper renders a bounded PNG through the manifest path')
}

try {
    await verifyPdfTextHelper(resolved.pdfTextHelperPath)
    check(true, 'native PDF text helper reads upright, rotated and scanned pages through the manifest path')
} catch {
    check(false, 'native PDF text helper reads upright, rotated and scanned pages through the manifest path')
}

const probeHome = await mkdtemp(join(tmpdir(), 'rerun-verify-codex-'))
try {
    await Promise.all(['state', 'tmp'].map(name => mkdir(join(probeHome, name), { mode: 0o700 })))
    const { pnpm } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
    const pinnedVersion = pnpm.overrides['ai-sdk-provider-codex-cli@1.3.1>@openai/codex']
    const version = await output(resolved.codexPath, ['--version'], { env: { RERUN_CODEX_PROFILE: probeHome, RERUN_MAC_HOME: userInfo().homedir }, timeout: 15000 }).catch(() => '')
    check(version === `codex-cli ${pinnedVersion}`, 'isolated bundled Codex CLI matches the pinned version')
} finally { await rm(probeHome, { recursive: true, force: true }) }

const claudeProbe = await realpath(await mkdtemp(join(tmpdir(), 'rerun-verify-claude-')))
try {
    await mkdir(join(claudeProbe, 'tmp'), { mode: 0o700 })
    const requireEngine = createRequire(join(engineDir, 'package.json'))
    const requireAdapter = createRequire(requireEngine.resolve('ai-sdk-provider-claude-code'))
    const sdk = JSON.parse(await readFile(join(dirname(requireAdapter.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8'))
    const version = await output('/usr/bin/sandbox-exec', ['-D', `PROFILE=${claudeProbe}`, '-D', `BINARY=${resolved.claudePath}`, '-f', resolved.claudeSandboxPath, resolved.claudePath, '--version'], { cwd: claudeProbe, env: { PATH: '/usr/bin:/bin', HOME: claudeProbe, CLAUDE_CONFIG_DIR: claudeProbe, TMPDIR: join(claudeProbe, 'tmp') }, timeout: 15000 }).catch(() => '')
    check(version === `${sdk.claudeCodeVersion} (Claude Code)`, 'isolated bundled Claude CLI matches the locked SDK')
} finally { await rm(claudeProbe, { recursive: true, force: true }) }

if (resolved.subscriptionSandboxPath) {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'rerun-verify-subscriptions-')))
    const module = pathToFileURL(join(engineDir, 'dist/desktop/subscription-acp/runtime.js')).href
    const script = `
        import { openOfflineDesktopSubscriptionRunner, stopDesktopSubscriptionRunners } from ${JSON.stringify(module)}
        const provider = process.argv[1]
        let signedOut = false
        try {
            const session = await openOfflineDesktopSubscriptionRunner(provider)
            await session.close()
        } catch (error) {
            signedOut = error.code === 'auth-required'
        }
        await stopDesktopSubscriptionRunners()
        console.log(signedOut ? 'signed-out' : 'unverified')
    `
    let confirmed = true
    try {
        for (const [provider, binary, variable] of [
            ['grok-build', resolved.grokBuildPath, 'RERUN_DESKTOP_GROK_BUILD_RUNNER'],
            ['kimi-code', resolved.kimiCodePath, 'RERUN_DESKTOP_KIMI_CODE_RUNNER'],
        ]) {
            if (!binary) continue
            const result = await output(resolved.nodePath, ['--input-type=module', '-e', script, provider], {
                cwd: workspace, timeout: 25000,
                env: {
                    PATH: '/usr/bin:/bin', HOME: workspace,
                    RERUN_DESKTOP_APP: '1', RERUN_DATA_DIR: workspace, RERUN_DESKTOP_ENGINE_ROOT: workspace,
                    RERUN_DESKTOP_SUBSCRIPTION_SANDBOX: resolved.subscriptionSandboxPath,
                    [variable]: binary,
                },
            }).catch(() => { confirmed = false; return '' })
            check(result === 'signed-out', `bundled ${provider} refuses an offline signed-out profile`)
        }
    } finally {
        if (confirmed) await rm(workspace, { recursive: true, force: true })
    }
}

async function probe(moduleName, cwd, expression) {
    const script = `const m = await import('${moduleName}'); ${expression}`
    try {
        const { stdout } = await execFileAsync(resolved.nodePath, ['--input-type=module', '-e', script], { cwd, timeout: 30000 })
        return `ok ${stdout.trim()}`
    } catch (error) {
        return `error ${error.message}`
    }
}

const libsql = await probe('@libsql/client', engineDir, `const c = m.createClient({ url: 'file::memory:' }); await c.execute('select 1 as one'); console.log('libsql-native')`)
check(libsql.startsWith('ok'), `engine @libsql/client loads under bundled node (${libsql})`)
const sharp = await probe('sharp', engineDir, `console.log('sharp-' + m.default.versions.sharp ?? 'loaded')`)
check(sharp.startsWith('ok'), `engine sharp loads under bundled node (${sharp})`)

try {
    const uiSharp = await readUiSharpManifest(uiDir)
    for (const alias of uiSharp.aliases) {
        const conversion = await probe(alias, join(uiDir, '.next'), `
            const sharp = m.default;
            if (sharp.versions.sharp !== ${JSON.stringify(uiSharp.version)}) throw new Error('Wrong UI Sharp version');
            const png = await sharp({ create: { width: 512, height: 256, channels: 3, background: '#f00' } }).png().toBuffer();
            const webp = await sharp(png).rotate().resize(256, 256, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, effort: 6 }).toBuffer();
            const metadata = await sharp(webp).metadata();
            if (metadata.format !== 'webp' || metadata.width !== 256 || metadata.height !== 128) throw new Error('UI logo conversion failed');
            console.log('ui-sharp-' + sharp.versions.sharp + '-webp');
        `)
        check(conversion.startsWith('ok'), `UI Sharp logo conversion through ${alias} (${conversion})`)
    }
} catch (error) {
    check(false, `UI Sharp runtime metadata (${error.message})`)
}

refuseFailures()
console.log('\nruntime verification passed')
