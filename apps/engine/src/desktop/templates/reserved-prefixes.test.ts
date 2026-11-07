import { expect, test } from 'vitest'
import { isReservedTemplateMetadataPath } from './files.ts'
import { isTemplateManifestPath } from './install.ts'

test.each([
    'workspace/.rerun-cache.txt', 'workspace/docs/.RERUNsecret/note.md',
    'skills/user/assets/.rerun-cache.txt', 'skills/user/references/.rerun-skill',
    'skills/user/.RERUN-SKILL-lock', 'skills/user/assets/.ｒｅｒｕｎ-data/file.txt',
])('reserved metadata stays excluded at capture and install: %s', path => {
    expect(isReservedTemplateMetadataPath(path)).toBe(true)
    expect(isTemplateManifestPath(path)).toBe(false)
})
test.each(['workspace/.user-note', 'skills/user/assets/.user-data.json', 'skills/user/references/user.rerun.md'])('ordinary user assets remain portable: %s', path => {
    expect(isReservedTemplateMetadataPath(path)).toBe(false)
    expect(isTemplateManifestPath(path)).toBe(true)
})
