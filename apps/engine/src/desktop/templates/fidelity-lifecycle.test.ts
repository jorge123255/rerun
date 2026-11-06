import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, afterEach, expect, test } from 'vitest'
import { prepareSkillHelperFixture } from '../skill-publication.test-support.js'
import { createDesktopTemplateEngine } from './service.js'
import { createDesktopPortableTemplateService } from './portable-service.js'
import { rollbackFreshTemplateCoworker } from './fidelity-recovery.js'
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const oldHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async () => { helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path })
afterAll(async () => { if (oldHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = oldHelper; await helper.close() })
const roots:string[]=[]
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))) })
const id = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
async function fixture() {
    const dataRoot=await realpath(await mkdtemp(join(tmpdir(),'fidelity-library-'))),agentsRoot=await realpath(await mkdtemp(join(tmpdir(),'fidelity-agents-'))); roots.push(dataRoot,agentsRoot)
    const folder=join(agentsRoot,'source'); await mkdir(join(folder,'workspace'),{recursive:true}); await mkdir(join(folder,'skills','demo'),{recursive:true})
    await writeFile(join(folder,'config.json'),JSON.stringify({name:'Fixture',verbosity:'detailed',setup:{required:false},connectionId:'secret-connection',tools:{browser:true}}),{mode:0o600})
    await writeFile(join(folder,'.env'),'API_TOKEN=private-value-must-stay\n',{mode:0o600})
    await writeFile(join(folder,'workspace','asset.bin'),Buffer.from([0,255,1,2]),{mode:0o600})
    await writeFile(join(folder,'skills','demo','SKILL.md'),'---\nname: Demo\n---\nBody\n',{mode:0o600})
    await writeFile(join(folder,'skills','demo','asset.bin'),Buffer.from([0,3,4]),{mode:0o600})
    const names=new Map<string,string>(), index={get:async (key:string)=>names.has(key)?{name:names.get(key)!}:null,insert:async (key:string,name:string)=>{names.set(key,name)}}
    const engine=createDesktopTemplateEngine({dataRoot,agentsRoot},index,{includeBinary:true,skillOwnership:async ()=>'user',requirementNames:async()=>[{kind:'service-reconnect',name:'notion'}]})
    const draft=await engine.createDraft(id(1),'Fidelity'), plan=await engine.plan({...draft,requestId:id(1),coworkers:[{agentId:id(2),engineAgentId:'source'}]})
    const capture={...draft,requestId:id(3),planRevision:plan.planRevision,selections:[{agentId:id(2),files:['workspace/asset.bin'],skills:['demo']}]}
    const captured=await engine.capture(capture)
    return {dataRoot,agentsRoot,names,engine,captured,plan,capture,folder}
}
test('complete byte/skill capture, import identity, setup requirements and deletion retain installed siblings',async()=>{
    const f=await fixture(),detail=await f.engine.detail(f.captured.templateId,f.captured.revision)
    expect(detail.coworkers[0].requirements?.map(r=>r.name)).toEqual(expect.arrayContaining(['API_TOKEN','notion','connection']))
    expect(JSON.stringify(detail)).not.toContain('private-value-must-stay'); expect(JSON.stringify(detail)).not.toContain('secret-connection')
    expect(await f.engine.capture(f.capture)).toEqual(f.captured)
    const artifact=new Map<string,Buffer>(),portable=createDesktopPortableTemplateService({dataRoot:f.dataRoot,publishDownloadArtifact:async bytes=>{artifact.set('a'.repeat(32),bytes);return{artifactId:'a'.repeat(32)}},readImmutableUpload:async()=>artifact.get('a'.repeat(32))!})
    const exported=await portable.handle({operation:'export',requestId:id(4),templateId:f.captured.templateId,revision:f.captured.revision});expect(exported.status).toBe('exported')
    const imported=await portable.handle({operation:'import-package',requestId:id(5),uploadId:id(6)})
    expect(imported.status).toBe('imported');if(imported.status!=='imported')throw Error('fixture import')
    expect(imported.templateId).not.toBe(f.captured.templateId)
    const restarted=createDesktopPortableTemplateService({dataRoot:f.dataRoot,publishDownloadArtifact:async()=>{throw Error('must not republish')},readImmutableUpload:async()=>{throw Error('must not reread')}})
    expect(await restarted.handle({operation:'import-package',requestId:id(5),uploadId:id(6)})).toEqual(imported)
    const installed=await f.engine.install({importReceiptId:id(7),templateId:imported.templateId,revision:imported.revision,coworkers:[{engineAgentId:`i${'b'.repeat(31)}`,agentKey:'c00'}]})
    expect(installed.status).toBe('ready')
    expect(await readFile(join(f.agentsRoot,`i${'b'.repeat(31)}`,'skills','demo','asset.bin'))).toEqual(Buffer.from([0,3,4]))
    const deleteRequest={operation:'delete' as const,requestId:id(8),templateId:imported.templateId,revision:imported.revision}
    const deleted=await portable.handle(deleteRequest);expect(deleted.status).toBe('deleted');expect(await portable.handle(deleteRequest)).toEqual(deleted)
    await access(join(f.agentsRoot,`i${'b'.repeat(31)}`,'config.json'));await access(join(f.folder,'config.json'))
    expect(artifact.size).toBe(1); expect(f.names.has(`i${'b'.repeat(31)}`)).toBe(true)
})
test('rollback refuses new user data and missing exact index authority',async()=>{
    const f=await fixture(),engineAgentId=`i${'c'.repeat(31)}`,importReceiptId=id(9)
    await f.engine.install({importReceiptId,templateId:f.captured.templateId,revision:f.captured.revision,coworkers:[{engineAgentId,agentKey:'c00'}]})
    const request={requestId:id(10),importReceiptId,templateId:f.captured.templateId,revision:f.captured.revision,engineAgentId,agentKey:'c00'}
    await expect(rollbackFreshTemplateCoworker(request,{dataRoot:f.dataRoot,agentsRoot:f.agentsRoot})).rejects.toMatchObject({status:503})
    await writeFile(join(f.agentsRoot,engineAgentId,'workspace','new.txt'),'Keep me',{mode:0o600})
    let removed=0
    await expect(rollbackFreshTemplateCoworker(request,{dataRoot:f.dataRoot,agentsRoot:f.agentsRoot,withFreshImportLease:async(_r,work)=>work(),removeOwnedIndex:async()=>{removed++;return'removed'}})).rejects.toMatchObject({status:409})
    expect(removed).toBe(0);expect(await readFile(join(f.agentsRoot,engineAgentId,'workspace','new.txt'),'utf8')).toBe('Keep me')
})

test('draft deletion is revision-CAS and old create acknowledgement cannot resurrect it',async()=>{
    const f=await fixture(),draft=await f.engine.createDraft(id(30),'Uncaptured draft'),portable=createDesktopPortableTemplateService({dataRoot:f.dataRoot,publishDownloadArtifact:async()=>({artifactId:'a'.repeat(32)}),readImmutableUpload:async()=>Buffer.alloc(0)})
    await expect(portable.handle({operation:'delete',requestId:id(31),templateId:draft.templateId,revision:'f'.repeat(64)})).rejects.toMatchObject({status:409})
    expect((await portable.handle({operation:'delete',requestId:id(32),templateId:draft.templateId,revision:draft.revision})).status).toBe('deleted')
    await expect(f.engine.createDraft(id(30),'Uncaptured draft')).rejects.toMatchObject({status:409})
    expect((await f.engine.list()).templates.some(t=>t.templateId===f.captured.templateId)).toBe(true)
})

test('partial index acknowledgement resumes the exact new identity after restart and duplicate install',async()=>{
    const f=await fixture(),engineAgentId=`i${'d'.repeat(31)}`,request={importReceiptId:id(40),templateId:f.captured.templateId,revision:f.captured.revision,coworkers:[{engineAgentId,agentKey:'c00'}]}
    const interrupted=createDesktopTemplateEngine({dataRoot:f.dataRoot,agentsRoot:f.agentsRoot},{get:async()=>null,insert:async()=>{throw Error('lost index ACK')}})
    expect((await interrupted.install(request)).status).toBe('uncertain')
    const resumed=await f.engine.install(request);expect(resumed.status).toBe('ready')
    expect(await f.engine.install(request)).toEqual(resumed)
    expect(f.names.size).toBe(1)
})

test('fresh rollback receipts reconcile the same exact folder across restart',async()=>{
    const f=await fixture(),engineAgentId=`i${'e'.repeat(31)}`,importReceiptId=id(50)
    await f.engine.install({importReceiptId,templateId:f.captured.templateId,revision:f.captured.revision,coworkers:[{engineAgentId,agentKey:'c00'}]})
    const request={requestId:id(51),importReceiptId,templateId:f.captured.templateId,revision:f.captured.revision,engineAgentId,agentKey:'c00'}
    let removes=0
    const deps={dataRoot:f.dataRoot,agentsRoot:f.agentsRoot,withFreshImportLease:async<T>(_r:unknown,work:()=>Promise<T>)=>work(),removeOwnedIndex:async()=>{removes++;f.names.delete(engineAgentId);return'removed' as const}}
    expect((await rollbackFreshTemplateCoworker(request,deps)).status).toBe('rolled-back')
    expect((await rollbackFreshTemplateCoworker(request,deps)).status).toBe('rolled-back')
    expect(removes).toBe(1);await expect(access(join(f.agentsRoot,engineAgentId))).rejects.toThrow()
    await access(join(f.folder,'config.json'))
})
