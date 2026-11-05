import { lstat, mkdir, mkdtemp, rm, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, output, repoRoot, resourcesDir } from './lib.mjs'
import { readUiSharpManifest } from './ui-sharp.mjs'
import { verifyPdfHelper } from './pdf-helper-probe.mjs'
import { verifyPdfTextHelper } from './pdf-text-probe.mjs'

const execFileAsync = promisify(execFile)
const failures = []
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures.push(label) }

const manifest = JSON.parse(await readFile(join(resourcesDir, 'runtime-manifest.json'), 'utf8'))
check(manifest.protocolVersion === 1 && typeof manifest.buildId === 'string' && manifest.buildId.length > 0, 'manifest protocolVersion/buildId')

const resolved = {}
for (const field of ['nodePath', 'uiRoot', 'engineEntry', 'uiHost', 'codexPath', 'renameHelperPath', 'pdfHelperPath', 'pdfTextHelperPath']) {
    const path = resolve(resourcesDir, manifest[field] ?? '')
    resolved[field] = path
    const rel = relative(resourcesDir, path)
    check(!rel.startsWith('..') && existsSync(path), `manifest ${field} exists inside resources`)
}

const nodeVersion = await output(resolved.nodePath, ['--version']).catch(error => `error: ${error.message}`)
check(nodeVersion === 'v22.23.4', `bundled node runs (${nodeVersion})`)

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

const engineDir = join(resourcesDir, 'runtime', 'engine')
const uiDir = join(resourcesDir, 'runtime', 'ui')
check(existsSync(join(uiDir, 'server.js')), 'ui server.js staged')
check(!['components', 'test'].some(dir => existsSync(join(uiDir, dir))), 'compiled UI ships without source components or test fixtures')
check(existsSync(join(uiDir, '.next', 'static')), 'ui .next/static staged')
check(existsSync(join(uiDir, 'public')), 'ui public staged')
check(existsSync(join(engineDir, 'dist', 'cli', 'bin.js')), 'engine bin entry staged')
check(existsSync(join(resourcesDir, 'runtime', 'node', 'bin', 'npm')) || existsSync(join(resourcesDir, 'runtime', 'node', 'lib', 'node_modules', 'npm')), 'bundled npm staged')

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

const forbidden = /^\.env($|\.)/i
const secretExt = /\.(pem|key|p12|pfx|mobileprovision|jks|keystore)$/i
const offenders = []
const escapees = []
async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
            if (['.git', '.svn', '.hg'].includes(entry.name)) offenders.push(path)
            else await scan(path)
        } else if (entry.isSymbolicLink()) {
            const target = await realpath(path).catch(() => null)
            if (target && relative(await realpath(resourcesDir), target).startsWith('..' + sep)) escapees.push(path)
        } else if (forbidden.test(entry.name) || secretExt.test(entry.name)) {
            offenders.push(path)
        }
    }
}
await scan(resourcesDir)
check(offenders.length === 0, `no secrets/vcs files staged${offenders.length ? ` (${offenders.join(', ')})` : ''}`)
check(escapees.length === 0, `no symlinks escape resources${escapees.length ? ` (${escapees.join(', ')})` : ''}`)

if (failures.length) {
    console.error(`\n${failures.length} verification failure(s)`)
    process.exit(1)
}
console.log('\nruntime verification passed')
