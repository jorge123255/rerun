import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,realpath,utimes} from 'node:fs/promises'
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

it('emits unsupported receipts for added binary without retaining bytes; text still digests',async()=>{
 const folder=await realpath(await mkdtemp(join(tmpdir(),'native-writeback-')));folders.push(folder)
 const source=join(folder,'source'),scratch=join(folder,'scratch');config.root=source
 for(const path of [source,scratch]){await mkdir(join(path,'notes'),{recursive:true});await writeFile(join(path,'notes','a.md'),'before')}
 const ctx={agent:{id:'engine'},sessionId:'session',runId:'run'} as RunContext
 const baseline=await captureNativeBaseline(ctx,scratch,async()=>{})
 await writeFile(join(scratch,'notes','a.md'),'after')
 await writeFile(join(scratch,'notes','blob.bin'),Buffer.from([0,1,2,3,255]))
 await writeFile(join(scratch,'notes','photo.png'),'pretend-png-bytes')
 await symlink(join(folder,'outside.bin'),join(scratch,'notes','link.bin')).catch(async()=>{await writeFile(join(folder,'outside.bin'),'x');await symlink(join(folder,'outside.bin'),join(scratch,'notes','link.bin'))})
 await writeFile(join(scratch,'.hidden.bin'),Buffer.from([9]))
 const huge=Buffer.alloc(65*1024,7);await writeFile(join(scratch,'notes','huge.bin'),huge)
 const proposal=await captureNativeChanges(ctx,scratch,baseline)
 expect(proposal.files.map(f=>f.path).sort()).toEqual(['notes/a.md'])
 expect(proposal.files[0]?.after).toBe('after')
 const paths=proposal.unsupported.map(f=>f.path).sort()
 expect(paths).toEqual(['notes/blob.bin','notes/huge.bin','notes/photo.png'])
 expect(proposal.unsupported.every(f=>f.reason==='binary-or-non-text')).toBe(true)
 expect(JSON.stringify(proposal)).not.toContain('\u0000')
 expect(JSON.stringify(proposal)).not.toMatch(/pretend-png|\x00|outside/)
 expect(proposal.unsupported.some(f=>f.path.includes('link'))).toBe(false)
 expect(proposal.unsupported.some(f=>f.path.startsWith('.'))).toBe(false)
 expect(await readFile(join(source,'notes','a.md'),'utf8')).toBe('before')
})
it('all-binary scratch yields unsupported-only bundle and no text rows',async()=>{
 const folder=await realpath(await mkdtemp(join(tmpdir(),'native-writeback-')));folders.push(folder)
 const source=join(folder,'source'),scratch=join(folder,'scratch');config.root=source
 for(const path of [source,scratch])await mkdir(path,{recursive:true})
 const ctx={agent:{id:'engine'},sessionId:'session',runId:'run'} as RunContext
 const baseline=await captureNativeBaseline(ctx,scratch,async()=>{})
 await writeFile(join(scratch,'only.bin'),Buffer.from([1,2,3]))
 const proposal=await captureNativeChanges(ctx,scratch,baseline)
 expect(proposal.files).toEqual([])
 expect(proposal.unsupported).toEqual([expect.objectContaining({path:'only.bin',reason:'binary-or-non-text'})])
})
it('unchanged copied non-text is not proposed',async()=>{
 const folder=await realpath(await mkdtemp(join(tmpdir(),'native-writeback-')));folders.push(folder)
 const source=join(folder,'source'),scratch=join(folder,'scratch');config.root=source
 for(const path of [source,scratch]){await mkdir(path,{recursive:true});await writeFile(join(path,'same.bin'),Buffer.from([4,5,6]))}
 const ctx={agent:{id:'engine'},sessionId:'session',runId:'run'} as RunContext
 const baseline=await captureNativeBaseline(ctx,scratch,async()=>{})
 expect(Object.keys(baseline.nonText.get('same.bin')!).sort()).toEqual(['size','version'])
 const proposal=await captureNativeChanges(ctx,scratch,baseline)
 expect(proposal.files).toEqual([])
 expect(proposal.unsupported).toEqual([])
})

it('a same-size non-text rewrite stays unsupported and never becomes a text publication',async()=>{
 const folder=await realpath(await mkdtemp(join(tmpdir(),'native-writeback-')));folders.push(folder)
 const source=join(folder,'source'),scratch=join(folder,'scratch');config.root=source
 for(const path of [source,scratch]){await mkdir(path,{recursive:true});await writeFile(join(path,'same.bin'),Buffer.from([4,5,6]))}
 const ctx={agent:{id:'engine'},sessionId:'session',runId:'run'} as RunContext
 const baseline=await captureNativeBaseline(ctx,scratch,async()=>{})
 await writeFile(join(scratch,'same.bin'),Buffer.from([7,8,9]))
 // Make the metadata change deterministic without depending on filesystem clock precision.
 await utimes(join(scratch,'same.bin'),new Date('2030-01-01T00:00:00Z'),new Date('2030-01-01T00:00:00Z'))
 const proposal=await captureNativeChanges(ctx,scratch,baseline)
 expect(proposal.files).toEqual([])
 expect(proposal.unsupported).toEqual([expect.objectContaining({path:'same.bin',reason:'binary-or-non-text'})])
 expect(await readFile(join(source,'same.bin'))).toEqual(Buffer.from([4,5,6]))
 expect(JSON.stringify(proposal)).not.toContain('afterHash')
})
