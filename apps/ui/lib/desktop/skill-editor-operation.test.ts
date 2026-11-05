import { describe, expect, it } from 'vitest'
import { skillEditorOperationApplies } from './skill-editor-operation'

const owner = 'agent\0slug\0references/a.md'
const other = 'agent\0slug\0references/b.md'

describe('skillEditorOperationApplies', () => {
    it('applies when the editor is still mounted on the same file and generation', () => {
        expect(skillEditorOperationApplies({ mounted: true, generation: 2, owner }, { generation: 2, owner })).toBe(true)
    })

    it('ignores a save that finishes after Back opens another file', () => {
        expect(skillEditorOperationApplies({ mounted: true, generation: 4, owner: other }, { generation: 2, owner })).toBe(false)
    })

    it('ignores a save that finishes after the editor unmounts', () => {
        expect(skillEditorOperationApplies({ mounted: false, generation: 3, owner }, { generation: 2, owner })).toBe(false)
    })

    it('ignores a save superseded by a later click', () => {
        expect(skillEditorOperationApplies({ mounted: true, generation: 3, owner }, { generation: 2, owner })).toBe(false)
    })
})
