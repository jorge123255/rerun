import { mkdtempSync,realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve,join } from 'node:path'
import { mkdir,writeFile,readFile,access,unlink,rename,cp } from 'node:fs/promises'
import { beforeAll,afterAll,expect,test,vi } from 'vitest'
process.env.RERUN_DATA_DIR=realpathSync(mkdtempSync(resolve(tmpdir(),'rerun-import-cleanup-')))
const interruption=vi.hoisted(()=>({enabled:false}))
vi.mock('./portable-lock.js',async original=>{
 const module=await original<typeof import('./portable-lock.js')>()
 return {...module,removePortableQuarantinedDirectory:async(parent:string,name:string,identity:{dev:string;ino:string})=>{
  if(interruption.enabled){interruption.enabled=false;await unlink(join(parent,name,'.desktop-template-import.json'));throw Error('Interrupted after index removal')}
  return module.removePortableQuarantinedDirectory(parent,name,identity)
 }}
})
const {dataDir,agentsDir}=await import('../../config/paths.js')
const {raw}=await import('../../db/client.js')
const {createDesktopTemplateEngine}=await import('./service.js')
const {rollbackDesktopTemplateInstall}=await import('./rollback-binding.js')
const {initializeImportedSetup}=await import('../setup/service.js')
const {closeSystemDb,getSystemDb}=await import('../../db/systemDb.js')
const {desktopScheduleOccurrenceSchema}=await import('../../runtime/desktop-schedule-state.js')
const {prepareSkillHelperFixture}=await import('../skill-publication.test-support.js')
let helper:Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const priorHelper=process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async()=>{
 helper=await prepareSkillHelperFixture();process.env.RERUN_DESKTOP_RENAME_HELPER=helper.path
 vi.stubEnv('RERUN_HUB_BASE_URL','http://127.0.0.1:48999');vi.stubEnv('RERUN_API_KEY','fixture-only')
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{const input=JSON.parse(String(init.body));return Response.json({requestId:input.requestId,importReceiptId:input.importReceiptId,unpublished:true})})
 await mkdir(agentsDir(),{recursive:true})
 await raw().executeMultiple("CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'idle',created_at TEXT NOT NULL)")
})
afterAll(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();if(priorHelper===undefined)delete process.env.RERUN_DESKTOP_RENAME_HELPER;else process.env.RERUN_DESKTOP_RENAME_HELPER=priorHelper;await helper.close()})
async function fixture(suffix:string){
 const source='source-'+suffix,folder=join(agentsDir(),source)
 await mkdir(join(folder,'workspace'),{recursive:true})
 await writeFile(join(folder,'config.json'),JSON.stringify({name:'Source '+suffix,enabled:false,setup:{required:false}}),{mode:0o600})
 await writeFile(join(folder,'workspace','note.txt'),'Original bytes',{mode:0o600})
 const engine=createDesktopTemplateEngine({dataRoot:dataDir(),agentsRoot:agentsDir()})
 const draft=await engine.createDraft(crypto.randomUUID(),'Cleanup '+suffix),sourceId=crypto.randomUUID()
 const plan=await engine.plan({...draft,requestId:crypto.randomUUID(),coworkers:[{agentId:sourceId,engineAgentId:source}]})
 const captured=await engine.capture({...draft,requestId:crypto.randomUUID(),planRevision:plan.planRevision,selections:[{agentId:sourceId,files:['workspace/note.txt'],skills:[]}]})
 const engineAgentId=`i${suffix.repeat(31)}`,install={importReceiptId:crypto.randomUUID(),templateId:captured.templateId,revision:captured.revision,coworkers:[{engineAgentId,agentKey:'c00'}]}
 expect((await engine.install(install)).status).toBe('ready')
 const body={...install,requestId:crypto.randomUUID()}
 return{engine,folder,engineAgentId,install,body,copy:join(agentsDir(),engineAgentId)}
}
test('production cleanup recovers a partial deletion without its removed import marker and never resurrects the cancelled import',async()=>{
 const f=await fixture('a');interruption.enabled=true
 await expect(rollbackDesktopTemplateInstall(f.body,{dataRoot:dataDir(),agentsRoot:agentsDir()})).rejects.toThrow('Interrupted after index removal')
 expect((await raw().execute({sql:'SELECT * FROM agents WHERE id=?',args:[f.engineAgentId]})).rows).toHaveLength(0)
 await expect(f.engine.install(f.install)).rejects.toThrow('cancelled')
 expect(await rollbackDesktopTemplateInstall(f.body,{dataRoot:dataDir(),agentsRoot:agentsDir()})).toMatchObject({status:'rolled-back',requestId:f.body.requestId})
 expect(await rollbackDesktopTemplateInstall(f.body,{dataRoot:dataDir(),agentsRoot:agentsDir()})).toMatchObject({status:'rolled-back'})
 await expect(access(f.copy)).rejects.toThrow()
 expect(await readFile(join(f.folder,'workspace','note.txt'),'utf8')).toBe('Original bytes')
})
test('production cleanup preserves a replaced index and a replaced folder even if the import marker was copied',async()=>{
 const first=await fixture('b')
 await raw().execute({sql:"UPDATE agents SET created_at='replacement-index' WHERE id=?",args:[first.engineAgentId]})
 await expect(rollbackDesktopTemplateInstall(first.body,{dataRoot:dataDir(),agentsRoot:agentsDir()})).rejects.toThrow('changed')
 await access(first.copy)
 const second=await fixture('c'),old=second.copy+'-original'
 await rename(second.copy,old);await cp(old,second.copy,{recursive:true})
 await expect(rollbackDesktopTemplateInstall(second.body,{dataRoot:dataDir(),agentsRoot:agentsDir()})).rejects.toThrow('fresh-folder')
 expect(await readFile(join(second.copy,'workspace','note.txt'),'utf8')).toBe('Original bytes')
})

async function setupBeforePlacement(f: Awaited<ReturnType<typeof fixture>>) {
 const { importReceiptId } = f.install
 await initializeImportedSetup({ agentId: crypto.randomUUID(), engineAgentId: f.engineAgentId, importReceiptId, prompt: '', required: false })
 const { client } = await getSystemDb(f.engineAgentId)
 await client.executeMultiple(desktopScheduleOccurrenceSchema)
 return client
}

test('production cleanup removes an unpublished copy after setup and empty restart database initialization', async () => {
 const f = await fixture('d')
 await setupBeforePlacement(f)
 await expect(rollbackDesktopTemplateInstall(f.body, { dataRoot: dataDir(), agentsRoot: agentsDir() })).resolves.toMatchObject({ status: 'rolled-back' })
 await expect(access(f.copy)).rejects.toMatchObject({ code: 'ENOENT' })
 expect(await readFile(join(f.folder, 'workspace', 'note.txt'), 'utf8')).toBe('Original bytes')
})

test('production cleanup refuses an initialized copy containing a saved chat', async () => {
 const f = await fixture('e')
 const client = await setupBeforePlacement(f)
 await client.execute({
  sql: "INSERT INTO sessions (id,agent_id,title,created_at,updated_at) VALUES (?,?,'Keep this chat','2026-01-01','2026-01-01')",
  args: [crypto.randomUUID(), f.engineAgentId],
 })
 await expect(rollbackDesktopTemplateInstall(f.body, { dataRoot: dataDir(), agentsRoot: agentsDir() })).rejects.toThrow('contains saved data')
 const reopened = await getSystemDb(f.engineAgentId)
 expect((await reopened.client.execute('SELECT title FROM sessions')).rows[0]?.title).toBe('Keep this chat')
 closeSystemDb(f.engineAgentId)
})

test('production cleanup still refuses edits to setup or imported notes', async () => {
 const f = await fixture('f')
 await setupBeforePlacement(f)
 for (const path of ['INSTALL.md', 'workspace/note.txt']) {
  const file = join(f.copy, path), original = await readFile(file)
  await writeFile(file, 'Keep this edit', { mode: 0o600 })
  await expect(rollbackDesktopTemplateInstall(f.body, { dataRoot: dataDir(), agentsRoot: agentsDir() })).rejects.toThrow('edited')
  expect(await readFile(file, 'utf8')).toBe('Keep this edit')
  await writeFile(file, original)
 }
 closeSystemDb(f.engineAgentId)
})

test('production cleanup refuses unfamiliar database tables and retains their rows', async () => {
 const f = await fixture('7')
 const client = await setupBeforePlacement(f)
 await client.executeMultiple("CREATE TABLE local_notes (body TEXT); INSERT INTO local_notes VALUES ('Keep this note')")
 await expect(rollbackDesktopTemplateInstall(f.body, { dataRoot: dataDir(), agentsRoot: agentsDir() })).rejects.toThrow('database schema')
 const reopened = await getSystemDb(f.engineAgentId)
 expect((await reopened.client.execute('SELECT body FROM local_notes')).rows[0]?.body).toBe('Keep this note')
 closeSystemDb(f.engineAgentId)
})
