import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeStamp, stampMatches, requireStamp } from './provenance.mjs'

test('the actual package entry forces stages, skips stage-only packaging and disables publishing for local targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-package-dispatch-'))
    try {
        const report = join(root, 'dispatched.jsonl')
        const stub = `import { appendFileSync } from 'node:fs'; export const repoRoot='/synthetic'; export const flag=name=>process.argv.includes(name); export const buildId=async()=> 'synthetic'; export const output=async()=> ''; export async function run(command,args,options){appendFileSync(process.env.PROVENANCE_TEST_REPORT,JSON.stringify({command,args,options})+'\\n')}`
        const signing = `export async function previewSigningArguments(){return ['-c.mac.identity=offline-fixture']}`
        const hook = `export async function load(url,context,next){if(url===${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)})return {format:'module',shortCircuit:true,source:${JSON.stringify(stub)}};if(url===${JSON.stringify(new URL('./signing.mjs', import.meta.url).href)})return {format:'module',shortCircuit:true,source:${JSON.stringify(signing)}};return next(url,context)}`
        const loader = join(root, 'loader.mjs')
        await writeFile(loader, hook)
        execFileSync(process.execPath, ['--loader', loader, fileURLToPath(new URL('./package.mjs', import.meta.url)), '--stage-only', '--build'], { env: { ...process.env, PROVENANCE_TEST_REPORT: report }, stdio: ['ignore', 'pipe', 'pipe'] })
        const calls = (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        assert.equal(calls.length, 10)
        assert(calls.every(call => call.args.includes('--build')))
        assert(calls.some(call => call.args[0].endsWith('/stage-ui.mjs')))
        assert(calls.some(call => call.args[0].endsWith('/stage-file-helper.mjs')))
        const pdfStage = calls.findIndex(call => call.args[0].endsWith('/stage-pdf-helper.mjs'))
        const textStage = calls.findIndex(call => call.args[0].endsWith('/stage-pdf-text.mjs'))
        assert(textStage > pdfStage && textStage < calls.findIndex(call => call.args[0].endsWith('/write-manifest.mjs')))
        assert(pdfStage >= 0 && pdfStage < calls.findIndex(call => call.args[0].endsWith('/write-manifest.mjs')))
        assert(calls.some(call => call.args[0].endsWith('/stage-engine.mjs')))
        assert(!calls.some(call => call.command === 'npx'))
        // Exercise the actual entry point under CI flags. All commands and signing
        // discovery are intercepted: no builder, native probe or Keychain is run.
        for (const [input, target] of [[[], ['--mac', '--arm64']], [['--dmg'], ['--mac', 'dmg']]]) {
            await writeFile(report, '')
            const outputDir = join(root, 'artifacts')
            execFileSync(process.execPath, ['--loader', loader, fileURLToPath(new URL('./package.mjs', import.meta.url)), ...input, '--output-dir', outputDir], {
                env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', PROVENANCE_TEST_REPORT: report },
                stdio: ['ignore', 'pipe', 'pipe'],
            })
            const packaged = (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
            const builders = packaged.filter(call => call.command === 'npx')
            assert.equal(builders.length, 1)
            assert.deepEqual(builders[0].args, ['--yes', 'electron-builder@26.18.1', ...target, '--publish', 'never', '--config', 'electron-builder.yml', '-c.mac.identity=offline-fixture', `-c.directories.output=${outputDir}`])
            assert.deepEqual(builders[0].options, { cwd: '/synthetic/apps/desktop' })
            assert.equal(packaged.filter(call => call.command === '/usr/bin/codesign').length, 1)
        }
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('cached output from another commit or without a build receipt cannot be labelled as current source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-provenance-'))
    const current = { protocolVersion: 1, sourceCommit: 'b'.repeat(40), buildId: 'bbbbbbb-desktop-0.1.0' }
    try {
        await writeFile(join(root, 'server.js'), 'synthetic older server')
        await assert.rejects(requireStamp(root, current), /Stale or unverified/)
        await writeStamp(root, { ...current, sourceCommit: 'a'.repeat(40) })
        assert.equal(await stampMatches(root, current), false)
        await assert.rejects(requireStamp(root, current), /Stale or unverified/)
        await writeStamp(root, current)
        await requireStamp(root, current)
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('engine staging cannot relabel a stale entry after the compiler emits a different directory layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-engine-layout-'))
    try {
        const dist = join(root, 'apps/engine/dist')
        await mkdir(join(dist, 'cli'), { recursive: true })
        await writeFile(join(dist, 'cli/bin.js'), 'old engine')
        const stub = `import {existsSync} from 'node:fs'; import {mkdir,writeFile} from 'node:fs/promises'; export {existsSync}; export const repoRoot=${JSON.stringify(root)}; export const resourcesDir=repoRoot+'/resources'; export const flag=()=>true; export const output=async(command,args)=>args[0]==='status'?'':'b'.repeat(40); export const buildId=async()=> 'layout-test'; export async function pnpm(args){ if(args.includes('build')) { if(existsSync(repoRoot+'/apps/engine/dist/cli/bin.js'))throw new Error('Stale entry survived'); await mkdir(repoRoot+'/apps/engine/dist/apps/engine/src/cli',{recursive:true}); await writeFile(repoRoot+'/apps/engine/dist/apps/engine/src/cli/bin.js','new misplaced engine'); } }`
        const loader = join(root, 'loader.mjs')
        await writeFile(loader, `export async function load(url,context,next){if(url===${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)})return {format:'module',shortCircuit:true,source:${JSON.stringify(stub)}};return next(url,context)}`)
        assert.throws(() => execFileSync(process.execPath, ['--loader', loader, fileURLToPath(new URL('./stage-engine.mjs', import.meta.url)), '--build'], { stdio: ['ignore', 'pipe', 'pipe'] }), error => {
            assert.match(String(error.stderr), /engine build did not produce dist\/cli\/bin.js/)
            return true
        })
        assert(!existsSync(join(dist, 'cli/bin.js')))
        assert(!existsSync(join(dist, 'desktop-build.json')))
    } finally { await rm(root, { recursive: true, force: true }) }
})


test('source stamps reject untracked build inputs while ordinary ignored build output remains allowed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-source-stamp-'))
    try {
        const checkout = join(root, 'checkout')
        await mkdir(checkout)
        const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
        git('init', '--quiet')
        await writeFile(join(checkout, '.gitignore'), 'node_modules/\ndist/\n')
        await writeFile(join(checkout, 'source.ts'), 'export const checkedIn = true\n')
        git('add', '.gitignore', 'source.ts')
        git('-c', 'user.name=Provenance fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'checked-in source')
        const commit = git('rev-parse', 'HEAD')
        const stub = `import {execFile} from 'node:child_process'; import {promisify} from 'node:util'; export const repoRoot=${JSON.stringify(checkout)}; export const buildId=async()=> 'source-stamp-fixture'; export async function output(command,args,options){return (await promisify(execFile)(command,args,options)).stdout.trim()}`
        const loader = join(root, 'loader.mjs')
        await writeFile(loader, `export async function load(url,context,next){if(url===${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)})return {format:'module',shortCircuit:true,source:${JSON.stringify(stub)}};return next(url,context)}`)
        const script = `const {sourceStamp}=await import(${JSON.stringify(new URL('./provenance.mjs', import.meta.url).href)}); console.log(JSON.stringify(await sourceStamp()))`
        const stamp = () => JSON.parse(execFileSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
        assert.equal(stamp().sourceCommit, commit)
        await mkdir(join(checkout, 'dist'))
        await writeFile(join(checkout, 'dist', 'generated.js'), 'ignored compiled output')
        await mkdir(join(checkout, 'node_modules'))
        await writeFile(join(checkout, 'node_modules', 'dependency.js'), 'ignored installed dependency')
        assert.equal(stamp().sourceCommit, commit)
        const route = join(checkout, 'apps/ui/app/uncommitted-page')
        await mkdir(route, { recursive: true })
        await writeFile(join(route, 'page.tsx'), 'export default function Page(){return "not in the commit"}\n')
        assert.throws(stamp, error => {
            assert.match(String(error.stderr), /source changes and untracked files/)
            return true
        })
        await rm(join(checkout, 'apps'), { recursive: true })
        assert.equal(stamp().sourceCommit, commit)
        await writeFile(join(checkout, 'source.ts'), 'export const checkedIn = false\n')
        assert.throws(stamp, error => {
            assert.match(String(error.stderr), /source changes and untracked files/)
            return true
        })
    } finally { await rm(root, { recursive: true, force: true }) }
})
