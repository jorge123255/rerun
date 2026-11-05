import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { createServiceSkill, removeServiceSkill, verifyServiceSkill } from './skill-resources'

const roots: string[] = []
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
    const base = await mkdtemp(join(tmpdir(), 'desktop-service-skills-'))
    roots.push(base)
    const root = join(base, 'skills')
    const skill = { name: 'render-usage', description: 'Use Render safely', body: '# Render\n\nRead before writing.' }
    const guard = async () => {}
    return { root, skill, guard, id: crypto.randomUUID() }
}

it('adopts the exact resource left by an interrupted install and records its content hash', async () => {
    const { root, skill, guard, id } = await fixture()
    const first = await createServiceSkill(root, id, 0, skill, guard)
    const recovered = await createServiceSkill(root, id, 0, skill, guard)
    expect(recovered).toEqual(first)
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/)
    await expect(verifyServiceSkill(root, first)).resolves.toBeUndefined()
})

it('refuses to overwrite or delete an edited connector skill', async () => {
    const { root, skill, guard, id } = await fixture()
    const owned = await createServiceSkill(root, id, 0, skill, guard)
    const manifest = join(root, owned.slug, 'SKILL.md')
    await writeFile(manifest, `${await readFile(manifest, 'utf8')}\nUser edit\n`)
    await expect(verifyServiceSkill(root, owned)).rejects.toThrow('preserved')
    await expect(removeServiceSkill(root, owned, guard)).rejects.toThrow('preserved')
    await expect(createServiceSkill(root, id, 0, skill, guard)).rejects.toThrow()
    expect(await readFile(manifest, 'utf8')).toContain('User edit')
})

it('removes only the exact owned resource and tolerates an already removed folder', async () => {
    const { root, skill, guard, id } = await fixture()
    const owned = await createServiceSkill(root, id, 0, skill, guard)
    await removeServiceSkill(root, owned, guard)
    await expect(removeServiceSkill(root, owned, guard)).resolves.toBeUndefined()
    await expect(readFile(join(root, owned.slug, 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
