import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeStamp, stampMatches, requireStamp } from './provenance.mjs'

test('the actual package entry forwards forced builds to all stages without launching a builder for stage-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-package-dispatch-'))
    try {
        const report = join(root, 'dispatched.jsonl')
        const stub = `import { appendFileSync } from 'node:fs'; export const repoRoot='/synthetic'; export const flag=name=>process.argv.includes(name); export const buildId=async()=> 'synthetic'; export const output=async()=> ''; export async function run(command,args){appendFileSync(process.env.PROVENANCE_TEST_REPORT,JSON.stringify({command,args})+'\\n')}`
        const hook = `export async function load(url,context,next){if(url===${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)})return {format:'module',shortCircuit:true,source:${JSON.stringify(stub)}};return next(url,context)}`
        const loader = join(root, 'loader.mjs')
        await writeFile(loader, hook)
        execFileSync(process.execPath, ['--loader', loader, fileURLToPath(new URL('./package.mjs', import.meta.url)), '--stage-only', '--build'], { env: { ...process.env, PROVENANCE_TEST_REPORT: report }, stdio: ['ignore', 'pipe', 'pipe'] })
        const calls = (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        assert.equal(calls.length, 9)
        assert(calls.every(call => call.args.includes('--build')))
        assert(calls.some(call => call.args[0].endsWith('/stage-ui.mjs')))
        assert(calls.some(call => call.args[0].endsWith('/stage-file-helper.mjs')))
        const pdfStage = calls.findIndex(call => call.args[0].endsWith('/stage-pdf-helper.mjs'))
        assert(pdfStage >= 0 && pdfStage < calls.findIndex(call => call.args[0].endsWith('/write-manifest.mjs')))
        assert(calls.some(call => call.args[0].endsWith('/stage-engine.mjs')))
        assert(!calls.some(call => call.command === 'npx'))
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
