import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DESKTOP_CODEX_ID } from './codex-runtime.js'

const root = await mkdtemp(join(tmpdir(), 'rerun-device-test-'))
vi.stubEnv('RERUN_DATA_DIR', root)
const { codexLoginAction, codexLoginStatus, stopCodexLogin } = await import('./codex-login.js')
const { readBoxDefault } = await import('../connections/default.js')
afterEach(async () => {
    stopCodexLogin()
    vi.unstubAllEnvs()
    if (root) await rm(root, { recursive: true, force: true })
})

test('device approval alone registers the runner catalog; cancel and logout clear their state', async () => {
    const cli = join(root, 'fixture-cli')
    await writeFile(cli, `#!${process.execPath}
const rl=require('node:readline').createInterface({input:process.stdin})
const send=m=>console.log(JSON.stringify(m))
rl.on('line', line=>{
 const m=JSON.parse(line); if(!m.id)return
 let result={}
 if(m.method==='account/login/start'){
  result={type:'chatgptDeviceCode',loginId:'owned',userCode:'TEST-CODE',verificationUrl:'https://auth.openai.com/codex/device'}
  setTimeout(()=>send({method:'account/login/completed',params:{loginId:'owned',success:true}}),400)
 }
 if(m.method==='account/read')result={account:{type:'chatgpt'}}
 if(m.method==='model/list')result={data:[{model:'test-model',hidden:false,isDefault:true},{model:'hidden',hidden:true,isDefault:false}]}
 send({id:m.id,result})
})
`, {mode:0o700})
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DATA_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', '1'.repeat(64))
    vi.stubEnv('RERUN_DESKTOP_CODEX_RUNNER', cli)
    expect((await codexLoginAction('start')).phase).toBe('waiting')
    expect((await codexLoginAction('cancel')).phase).toBe('idle')
    expect((await codexLoginAction('start')).phase).toBe('waiting')
    await vi.waitFor(async () => expect(await codexLoginStatus()).toEqual({phase:'connected'}), {timeout:4000})
    expect(await readBoxDefault()).toEqual({connectionId:DESKTOP_CODEX_ID,model:'test-model'})
    expect(await codexLoginAction('logout')).toEqual({phase:'idle'})
    expect(await readBoxDefault()).toBeNull()
})
