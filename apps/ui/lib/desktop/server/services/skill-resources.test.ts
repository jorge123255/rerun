import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import type {ServiceSkillJournal,SkillReservation} from './skill-journal'
import type {ServiceInstall} from './store'
import { createServiceSkill, removeServiceSkill, resolveServiceSkillRemoval, verifyServiceSkill } from './skill-resources'
import { prepareSkillHelperFixture } from '../../../../../engine/src/desktop/skill-publication.test-support'

const roots: string[] = []
const previousHelper=process.env.RERUN_DESKTOP_RENAME_HELPER
let helper:Awaited<ReturnType<typeof prepareSkillHelperFixture>>
beforeAll(async()=>{helper=await prepareSkillHelperFixture();process.env.RERUN_DESKTOP_RENAME_HELPER=helper.path},30_000)
afterAll(async()=>{if(previousHelper===undefined)delete process.env.RERUN_DESKTOP_RENAME_HELPER;else process.env.RERUN_DESKTOP_RENAME_HELPER=previousHelper;await helper.close()})
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'desktop-service-skills-')))
    roots.push(base)
    const root = join(base, 'skills')
    const skill = { name: 'render-usage', description: 'Use Render safely', body: '# Render\n\nRead before writing.' }
    const guard = async () => {}
    const record={id:crypto.randomUUID(),owner:'local',engineId:'engine'} as ServiceInstall
    let reservation:SkillReservation|null=null
    const journal:ServiceSkillJournal={
        async reserve(record,index,hash){
            if(reservation){if(reservation.hash!==hash)throw new Error('changed');return reservation}
            reservation={owner:record.owner,engineId:record.engineId,installationId:record.id,index,hash,slug:'svc-1234567890abcdef12345678-0',stageSlug:'svc-1234567890abcdef12345678-0-pending',state:'reserved',resource:null,publicationName:null};return reservation
        },
        async read(){return reservation},async list(){return reservation?[reservation]:[]},
        async update(r,state,resource,publicationName=r.publicationName){r.state=state;r.resource=resource;r.publicationName=publicationName},
    }
    return { root, skill, guard, record, journal }
}

it('reconciles only a canonically reserved resource and records its content hash', async () => {
    const { root, skill, guard, record, journal } = await fixture()
    const first = await createServiceSkill(root, record, 0, skill, guard, journal)
    const recovered = await createServiceSkill(root, record, 0, skill, guard, journal)
    expect(recovered).toEqual(first)
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/)
    await expect(verifyServiceSkill(root, first)).resolves.toBeUndefined()
})

it('refuses to overwrite or delete an edited connector skill', async () => {
    const { root, skill, guard, record, journal } = await fixture()
    const owned = await createServiceSkill(root, record, 0, skill, guard, journal)
    const manifest = join(root, owned.slug, 'SKILL.md')
    await writeFile(manifest, `${await readFile(manifest, 'utf8')}\nUser edit\n`)
    await expect(verifyServiceSkill(root, owned)).rejects.toThrow('preserved')
    await expect(removeServiceSkill(root, owned, guard)).rejects.toThrow('preserved')
    await expect(createServiceSkill(root, record, 0, skill, guard, journal)).rejects.toThrow()
    expect(await readFile(manifest, 'utf8')).toContain('User edit')
})

it('removes only the exact owned resource and tolerates an already removed folder', async () => {
    const { root, skill, guard, record, journal } = await fixture()
    const owned = await createServiceSkill(root, record, 0, skill, guard, journal)
    await removeServiceSkill(root, owned, guard)
    await expect(removeServiceSkill(root, owned, guard)).resolves.toBeUndefined()
    await expect(readFile(join(root, owned.slug, 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not publish after authority cancellation',async()=>{
    const {root,record,skill,journal}=await fixture()
    const controller=new AbortController();controller.abort()
    await expect(createServiceSkill(root,record,0,skill,async()=>controller.signal.throwIfAborted(),journal)).rejects.toBeDefined()
    expect(await journal.list(record.owner)).toEqual([])
})
it('refuses changed bytes under the same reserved identity',async()=>{
    const {root,record,skill,journal,guard}=await fixture()
    await createServiceSkill(root,record,0,skill,guard,journal)
    await expect(createServiceSkill(root,record,0,{...skill,body:'changed'},guard,journal)).rejects.toThrow('changed')
})
it('recovers a durable private staging reservation whose acknowledgement was lost',async()=>{
    const {root,record,skill,journal,guard}=await fixture()
    const original=journal.update
    journal.update=async(r,state,resource,name)=>{await original(r,state,resource,name);if(state==='staged')throw new Error('lost acknowledgement')}
    await expect(createServiceSkill(root,record,0,skill,guard,journal)).rejects.toThrow('lost acknowledgement')
    const reservation=(await journal.read(record.owner,record.id,0))!
    expect(reservation.state).toBe('staged')
    expect(reservation.publicationName).toMatch(/^\.rerun-skill-stage-/)
    const staged=await readFile(join(root,reservation.publicationName!,'SKILL.md'),'utf8')
    journal.update=original
    const recovered=await createServiceSkill(root,record,0,skill,guard,journal)
    expect(await readFile(join(root,recovered.slug,'SKILL.md'),'utf8')).toBe(staged)
    expect((await readdir(root)).filter(name=>name.startsWith('.rerun-skill-stage-'))).toEqual([])
})
it('removes the exact private staging inode after a lost acknowledgement',async()=>{
    const {root,record,skill,journal,guard}=await fixture()
    const original=journal.update
    journal.update=async(r,state,resource,name)=>{await original(r,state,resource,name);if(state==='staged')throw new Error('lost acknowledgement')}
    await expect(createServiceSkill(root,record,0,skill,guard,journal)).rejects.toThrow()
    const reservation=(await journal.read(record.owner,record.id,0))!
    const resource=await resolveServiceSkillRemoval(root,reservation,guard)
    await removeServiceSkill(root,resource,guard)
    expect((await readdir(root)).filter(name=>name.startsWith('svc-')||name.startsWith('.rerun-skill-stage-'))).toEqual([])
})
it('preserves an unjournalled private staging folder instead of adopting equal bytes',async()=>{
    const {root,record,skill,journal,guard}=await fixture()
    const original=journal.update
    journal.update=async(r,state,resource,name)=>{if(state==='staged')throw new Error('write refused');await original(r,state,resource,name)}
    await expect(createServiceSkill(root,record,0,skill,guard,journal)).rejects.toThrow('write refused')
    const unknown=(await readdir(root)).find(name=>name.startsWith('.rerun-skill-stage-'))!
    journal.update=original
    const recovered=await createServiceSkill(root,record,0,skill,guard,journal)
    expect(await readFile(join(root,unknown,'SKILL.md'),'utf8')).toContain('Read before writing')
    expect(recovered.slug).not.toBe(unknown)
})
it('does not treat a surviving folder with its manifest missing as an already removed resource',async()=>{
    const {root,record,skill,journal,guard}=await fixture()
    const resource=await createServiceSkill(root,record,0,skill,guard,journal)
    await rm(join(root,resource.slug,'SKILL.md'))
    await expect(removeServiceSkill(root,resource,guard)).rejects.toThrow('preserved')
    expect(await readdir(join(root,resource.slug))).toEqual([])
})
it('recovers a final rename with lost publication acknowledgement using recorded inode identity',async()=>{
    const {root,record,skill,journal,guard}=await fixture()
    const original=journal.update
    journal.update=async(r,state,resource,name)=>{if(state==='published')throw new Error('lost publication acknowledgement');await original(r,state,resource,name)}
    await expect(createServiceSkill(root,record,0,skill,guard,journal)).rejects.toThrow('lost publication acknowledgement')
    journal.update=original
    const recovered=await createServiceSkill(root,record,0,skill,guard,journal)
    expect(recovered.slug).toBe((await journal.read(record.owner,record.id,0))!.slug)
    expect((await journal.read(record.owner,record.id,0))!.state).toBe('published')
})
