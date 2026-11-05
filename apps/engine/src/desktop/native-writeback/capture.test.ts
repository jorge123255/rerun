import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
const config=vi.hoisted(()=>({root:''}))
vi.mock('../workspace-read.js',()=>({workspaceRoot:async()=>config.root}))
import {captureNativeBaseline,captureNativeChanges} from './capture.js'
import type {RunContext} from '../../runtime/context.js'
const folders:string[]=[]
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true})})
it('captures exact before identity, new bounded text only in copied folders, and no deletions/links/outside config',async()=>{
 const folder=await realpath(await mkdtemp(join(tmpdir(),'native-writeback-')));folders.push(folder)
 const source=join(folder,'source'),scratch=join(folder,'scratch');config.root=source
 for(const path of [source,scratch]){await mkdir(join(path,'notes'),{recursive:true});await writeFile(join(path,'notes','a.md'),'before');await writeFile(join(path,'removed.txt'),'keep original')}
 await writeFile(join(folder,'credentials.txt'),'outside secret')
 const ctx={agent:{id:'engine'},sessionId:'session',runId:'run'} as RunContext
 const baseline=await captureNativeBaseline(ctx,scratch,async()=>{})
 await writeFile(join(scratch,'notes','a.md'),'after');await writeFile(join(scratch,'notes','new.txt'),'new')
 await rm(join(scratch,'removed.txt'));await symlink(join(folder,'credentials.txt'),join(scratch,'link.txt'))
 await mkdir(join(scratch,'new-folder'));await writeFile(join(scratch,'new-folder','no.txt'),'not eligible')
 const proposal=await captureNativeChanges(ctx,scratch,baseline)
 expect(proposal.files.map(file=>file.path).sort()).toEqual(['notes/a.md','notes/new.txt'])
 expect(proposal.files.find(file=>file.path==='notes/a.md')?.before?.text).toBe('before')
 expect(await readFile(join(source,'notes','a.md'),'utf8')).toBe('before')
 expect(await readFile(join(source,'removed.txt'),'utf8')).toBe('keep original')
 expect(JSON.stringify(proposal)).not.toContain('outside secret')
})
