import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { desktopTemplateFidelityManifestSchema, DESKTOP_PORTABLE_TEMPLATE_LIMITS } from '@rerun/contracts'
import { templateMediaType, normalizeTemplateRequirements } from './fidelity.js'
import { readConfinedBytes, readEnvironmentKeyNames } from './files.js'
import { sealPortableManifest, writePortableArchive, readPortableArchive } from './portable-package.js'
import { sha256 } from './hash.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive:true, force:true }))) })
async function folder() { const root = await realpath(await mkdtemp(join(tmpdir(),'template-fidelity-'))); roots.push(root); return root }
function manifest(bytes: Buffer) {
    return sealPortableManifest({ format:'desktop-portable-template', formatVersion:1, packageKey:'a'.repeat(32), title:'Fixture', capturedAt:'2026-11-05T00:00:00.000Z',
        proseWarning:'Selected instructions, files, and skills are copied as written. This capture does not prove they contain no secrets.', limits:DESKTOP_PORTABLE_TEMPLATE_LIMITS,
        coworkers:[{ agentKey:'c00', name:'Fixture', description:'', setup:{required:false,prompt:'',answered:false}, members:[{path:'workspace/asset.bin',bytes:bytes.length,kind:'binary',binary:true,textScanned:false,flagged:[],contentDigest:sha256(bytes),mediaType:'application/octet-stream'}], exclusions:[],redactions:[],strippedConfigKeys:[],requirements:[],envKeys:[],mcpAuth:[] }],
        fidelity:{ binaryAssets:true,userSkillTrees:false,sourceKind:'portable-capture',notes:[] }, excludedCategories:['credentials'],
    })
}
test('binary archive bytes and metadata round trip deterministically without document decoding', async () => {
    const bytes = Buffer.from([0,255,1,2,3]), meta = manifest(bytes), input = { title:meta.title, packageKey:meta.packageKey, manifest:meta, members:[{agentKey:'c00',path:'workspace/asset.bin',bytes,digest:sha256(bytes)}],startedAt:Date.now() }
    const a = await writePortableArchive(input), b = await writePortableArchive(input)
    expect(a.archiveBytes.equals(b.archiveBytes)).toBe(true)
    const received = await readPortableArchive(a.archiveBytes)
    expect(received.members[0].bytes.equals(bytes)).toBe(true)
    expect(received.manifest.coworkers[0].members[0].mediaType).toBe('application/octet-stream')
})
test('old optional media metadata stays absent and unknown format versions refuse', () => {
    const m = manifest(Buffer.from([0])); const old = structuredClone(m)
    delete old.coworkers[0].members[0].mediaType
    expect(desktopTemplateFidelityManifestSchema.parse(old).coworkers[0].members[0]).not.toHaveProperty('mediaType')
    expect(desktopTemplateFidelityManifestSchema.safeParse({...m,formatVersion:99}).success).toBe(false)
})
test('corruption, changed member bytes and unsafe paths fail before publication', async () => {
    const bytes = Buffer.from([0,1]), meta = manifest(bytes)
    await expect(readPortableArchive(Buffer.from('not gzip'))).rejects.toThrow()
    await expect(writePortableArchive({title:'Fixture',packageKey:meta.packageKey,manifest:meta,members:[{agentKey:'c00',path:'workspace/asset.bin',bytes:Buffer.from([0,2]),digest:sha256(bytes)}],startedAt:Date.now()})).rejects.toThrow()
    for (const path of ['../escape','/absolute','workspace/../escape','workspace/line\nbreak']) expect(desktopTemplateFidelityManifestSchema.safeParse({...meta,coworkers:[{...meta.coworkers[0],members:[{...meta.coworkers[0].members[0],path}]}]}).success).toBe(false)
})
test('environment names never include values and links/hardlinks are rejected', async () => {
    const root = await folder(), bytes = 'TOKEN=never-export-this\nexport REGION=private-region\n'
    await writeFile(join(root,'.env'),bytes,{mode:0o600})
    expect(await readEnvironmentKeyNames(root)).toEqual(['REGION','TOKEN'])
    expect(JSON.stringify(await readEnvironmentKeyNames(root))).not.toContain('never-export-this')
    await mkdir(join(root,'workspace')); await writeFile(join(root,'workspace','asset.bin'),Buffer.from([0,1]),{mode:0o600})
    await symlink(join(root,'workspace','asset.bin'),join(root,'workspace','linked.bin'))
    expect((await readConfinedBytes(root,'workspace/linked.bin',100)).ok).toBe(false)
    const hardlink = join(root, 'workspace', 'hard.bin')
    await link(join(root, 'workspace', 'asset.bin'), hardlink)
    try {
        expect((await readConfinedBytes(root,'workspace/asset.bin',100)).ok).toBe(false)
        expect((await readFile(join(root,'.env'),'utf8'))).toBe(bytes)
    } finally {
        // Remove the alias before the recursive fixture cleanup reaches both names.
        await rm(hardlink, { force: true })
    }
})
test('requirements preserve identifiers and discard untrusted detail instead of treating prose as scrubbed', () => {
    expect(normalizeTemplateRequirements([{kind:'service-reconnect',name:'notion',detail:'https://private/?token=secret'}])[0].detail).not.toContain('secret')
    expect(() => normalizeTemplateRequirements([{kind:'environment-key',name:'KEY=value'}])).toThrow()
    expect(templateMediaType('active.pdf',Buffer.from('%PDF-1.7'),true)).toBe('application/pdf')
})
