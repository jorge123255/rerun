import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DESKTOP_CODEX_ID } from './codex-runtime.js'

let root: string
let login: typeof import('./codex-login.js')
let defaults: typeof import('../connections/default.js')
let registry: typeof import('../connections/registry.js')
const first = { model: 'recommended', hidden: false, isDefault: true }
const chosen = {
    model: 'terra', hidden: false, isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'balanced' }, { reasoningEffort: 'deep' }], defaultReasoningEffort: 'balanced',
}
const newModel = { model: 'new-account-model', hidden: false, isDefault: false }

function setPages(pages: Record<string, unknown>) {
    return writeFile(join(root, 'catalog.json'), JSON.stringify(pages))
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-device-test-'))
    const cli = join(root, 'fixture-cli')
    const script = join(root, 'fixture-cli.cjs')
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    // Account operations deliberately have no inherited PATH. A shell launcher also
    // supports the spaces in the bundled Node interpreter's application path.
    await writeFile(cli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 })
    await writeFile(script, `
const fs=require('node:fs'),path=require('node:path'),state=path.join(process.cwd(),'fixture-auth')
const send=m=>console.log(JSON.stringify(m))
require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line); if(!m.id)return
 let result={}
 if(m.method==='account/login/start'){
  result={type:'chatgptDeviceCode',loginId:'owned',userCode:'TEST-CODE',verificationUrl:'https://auth.openai.com/codex/device'}
  setTimeout(()=>{fs.writeFileSync(state,'ok');send({method:'account/login/completed',params:{loginId:'owned',success:true}})},400)
 }
 if(m.method==='account/read')result={account:fs.existsSync(state)?{type:'chatgpt'}:null}
 if(m.method==='account/logout')fs.rmSync(state,{force:true})
 if(m.method==='model/list'){
  const pages=JSON.parse(fs.readFileSync(path.join(__dirname,'catalog.json'),'utf8'))
  result=pages[m.params.cursor??'start']
  if(!result || m.params.includeHidden!==false){send({id:m.id,error:{message:'unexpected page request'}});return}
 }
 send({id:m.id,result})
})
`, { mode: 0o700 })
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DATA_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', '1'.repeat(64))
    vi.stubEnv('RERUN_DESKTOP_CODEX_RUNNER', cli)
    vi.resetModules()
    login = await import('./codex-login.js')
    defaults = await import('../connections/default.js')
    registry = await import('../connections/registry.js')
    await setPages({
        start: { data: [first, { model: 'internal', hidden: true, isDefault: false }], nextCursor: 'page2' },
        page2: { data: [first, chosen], nextCursor: null },
    })
})

afterEach(async () => {
    login.stopCodexLogin()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
})

async function signIn() {
    expect((await login.codexLoginAction('start')).phase).toBe('waiting')
    await vi.waitFor(async () => expect(await login.codexLoginStatus()).toEqual({ phase: 'connected' }), { timeout: 4000 })
}

async function storedModels() {
    return (await registry.getConnection(DESKTOP_CODEX_ID)).config.models
}

test('device approval registers all visible pages; cancel and logout clear their state', async () => {
    await defaults.writeBoxDefault({ connectionId: 'previous-provider', model: 'previous-model' })
    expect((await login.codexLoginAction('start')).phase).toBe('waiting')
    expect((await login.codexLoginAction('cancel')).phase).toBe('idle')
    await signIn()
    expect(await storedModels()).toEqual(['recommended', 'terra'])
    expect(await defaults.readBoxDefault()).toEqual({ connectionId: DESKTOP_CODEX_ID, model: 'recommended' })
    expect(await login.codexLoginAction('logout')).toEqual({ phase: 'idle' })
    expect(await defaults.readBoxDefault()).toBeNull()
    expect(await login.codexLoginAction('refresh')).toEqual({ phase: 'idle' })
})

test('refresh replaces the catalog, keeps the selected model or provider and handles a retired default', async () => {
    await signIn()
    const selected = { connectionId: DESKTOP_CODEX_ID, model: 'terra' }
    await defaults.writeBoxDefault(selected)
    await setPages({ start: { data: [first, chosen, newModel] } })
    expect(await login.codexLoginAction('refresh')).toEqual({ phase: 'connected' })
    expect(await storedModels()).toEqual(['recommended', 'terra', 'new-account-model'])
    expect(await defaults.readBoxDefault()).toEqual(selected)

    await setPages({ start: { data: [first, newModel], nextCursor: null } })
    expect(await login.codexLoginAction('refresh')).toEqual({ phase: 'connected' })
    expect(await defaults.readBoxDefault()).toEqual({ connectionId: DESKTOP_CODEX_ID, model: 'recommended' })
    const otherProvider = { connectionId: 'openai-key', model: 'other-model' }
    await defaults.writeBoxDefault(otherProvider)
    expect(await login.codexLoginAction('refresh')).toEqual({ phase: 'connected' })
    expect(await defaults.readBoxDefault()).toEqual(otherProvider)
    await defaults.clearBoxDefault()
    expect(await login.codexLoginAction('refresh')).toEqual({ phase: 'connected' })
    expect(await defaults.readBoxDefault()).toEqual({ connectionId: DESKTOP_CODEX_ID, model: 'recommended' })
})

test('a failed catalog page keeps the existing list, model and login', async () => {
    await signIn()
    const selected = { connectionId: DESKTOP_CODEX_ID, model: 'terra' }
    await defaults.writeBoxDefault(selected)
    await setPages({ start: { data: [newModel], nextCursor: 'unavailable' } })
    expect(await login.codexLoginAction('refresh')).toMatchObject({ phase: 'connected', catalogError: expect.stringContaining('model list') })
    expect(await login.codexLoginStatus()).toEqual({ phase: 'connected' })
    expect(await storedModels()).toEqual(['recommended', 'terra'])
    expect(await defaults.readBoxDefault()).toEqual(selected)
    await setPages({ start: { data: [newModel], nextCursor: 'again' }, again: { data: [], nextCursor: 'again' } })
    expect(await login.codexLoginAction('refresh')).toMatchObject({ phase: 'connected', catalogError: expect.any(String) })
    expect(await storedModels()).toEqual(['recommended', 'terra'])
})

test('only the active Codex model accepts a supported effort and refresh reconciles its preference', async () => {
    const alternative = { ...chosen, model: 'next', supportedReasoningEfforts: [{ reasoningEffort: 'deep' }], defaultReasoningEffort: 'deep' }
    await setPages({ start: { data: [first, chosen, alternative] } })
    await signIn()
    const catalog = (await registry.getConnection(DESKTOP_CODEX_ID)).config.codexReasoning
    expect(catalog?.terra).toEqual({ supported: ['balanced', 'deep'], default: 'balanced' })
    expect(catalog?.recommended).toEqual({ supported: [] })
    const engine = (await import('../http/server.js')).createServer()
    const pick = async (model: string, effort?: string | null) => {
        const response = await engine.request('/connections/default', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ connectionId: DESKTOP_CODEX_ID, model, reasoningEffort: effort }),
        })
        return response.status
    }
    expect(await pick('terra')).toBe(200)
    expect(await pick('terra', 'unsupported')).toBe(400)
    expect(await pick('terra', 'deep')).toBe(200)
    expect(await defaults.readBoxDefault()).toEqual({ connectionId: DESKTOP_CODEX_ID, model: 'terra', reasoningEffort: 'deep' })
    const { boxDefaultPath } = await import('../config/paths.js')
    expect(JSON.parse(await readFile(boxDefaultPath(), 'utf8')).reasoningEffort).toBe('deep')
    const otherProvider = await engine.request('/connections/default', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: 'openai', model: 'other', reasoningEffort: 'deep' }),
    })
    expect(otherProvider.status).toBe(400)
    await login.codexLoginAction('refresh')
    expect((await defaults.readBoxDefault())?.reasoningEffort).toBe('deep')
    expect(await pick('next')).toBe(200)
    expect(await pick('terra', 'balanced')).toBe(409)
    expect(await defaults.readBoxDefault()).toEqual({ connectionId: DESKTOP_CODEX_ID, model: 'next', reasoningEffort: 'deep' })
    expect(await pick('next', null)).toBe(200)
    expect((await defaults.readBoxDefault())?.reasoningEffort).toBeUndefined()
    expect(await pick('next', 'deep')).toBe(200)
    expect(await pick('recommended')).toBe(200)
    expect(await pick('recommended', 'deep')).toBe(400)
    expect((await defaults.readBoxDefault())?.reasoningEffort).toBeUndefined()
    expect(await pick('terra')).toBe(200)
    expect(await pick('terra', 'deep')).toBe(200)
    await setPages({ start: { data: [first, { ...chosen, supportedReasoningEfforts: [{ reasoningEffort: 'balanced' }] }] } })
    await login.codexLoginAction('refresh')
    expect(await defaults.readBoxDefault()).toEqual({ connectionId: DESKTOP_CODEX_ID, model: 'terra' })
    expect(await pick('terra', 'balanced')).toBe(200)
    await setPages({ start: { data: [{ ...chosen, model: 'replacement', isDefault: true }] } })
    await login.codexLoginAction('refresh')
    expect(await defaults.readBoxDefault()).toEqual({ connectionId: DESKTOP_CODEX_ID, model: 'replacement', reasoningEffort: 'balanced' })
})
