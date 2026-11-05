import { describe, expect, it } from 'vitest'
import { assertAgentId, assertContainerName, assertOwner, assertTarget, assertVolumeName, containerLabels, containerName, sameOwnerContainer, sameOwnerVolume, screenKey, volumeLabels, volumeName, LABEL_AGENT, LABEL_GENERATION, LABEL_MANAGED, LABEL_NONCE, LABEL_ROLE, ROLE_PROFILE, ROLE_SCREEN } from './identity.js'
import { IsolatedScreenRefusal } from './refusal.js'

const owner = { engineAgentId: 'coworker1', launchNonce: '11111111-1111-4111-8111-111111111111' }

describe('screen identity', () => {
    it('derives one stable container and volume name from the coworker id', () => {
        expect(screenKey(owner.engineAgentId)).toMatch(/^[a-f0-9]{32}$/)
        expect(containerName(owner.engineAgentId)).toBe(`rerun-screen-${screenKey(owner.engineAgentId)}`)
        expect(volumeName(owner.engineAgentId)).toBe(`rerun-screen-profile-${screenKey(owner.engineAgentId)}`)
        expect(containerName(owner.engineAgentId)).toBe(containerName(owner.engineAgentId))
        expect(containerName('coworker2')).not.toBe(containerName(owner.engineAgentId))
        expect(containerName(owner.engineAgentId).length).toBeLessThan(64)
        expect(volumeName(owner.engineAgentId).length).toBeLessThan(64)
    })

    it('rejects owner ids that could change a docker argument', () => {
        for (const engineAgentId of ['', 'a/b', 'a\0b', 'a\nb', '..', 'a..b', 'has space', 'x'.repeat(129)]) {
            expect(() => assertAgentId(engineAgentId)).toThrow(IsolatedScreenRefusal)
            expect(() => containerName(engineAgentId)).toThrow(IsolatedScreenRefusal)
        }
        expect(() => assertOwner({ engineAgentId: owner.engineAgentId, launchNonce: 'bad nonce' })).toThrow(IsolatedScreenRefusal)
        expect(() => assertTarget({ ...owner, sessionGeneration: 'not-hex' })).toThrow(IsolatedScreenRefusal)
        expect(() => assertContainerName('other')).toThrow(IsolatedScreenRefusal)
        expect(() => assertVolumeName('rerun-screen-profile-short')).toThrow(IsolatedScreenRefusal)
    })

    it('accepts only a container whose labels are this coworker', () => {
        const generation = 'ab'.repeat(16)
        const labels = containerLabels(owner, generation)
        expect(labels[LABEL_ROLE]).toBe(ROLE_SCREEN)
        expect(labels[LABEL_MANAGED]).toBe('1')
        expect(labels[LABEL_AGENT]).toBe(owner.engineAgentId)
        expect(sameOwnerContainer(labels, owner)).toBe(true)
        expect(sameOwnerContainer({ ...labels, [LABEL_ROLE]: 'other' }, owner)).toBe(false)
        expect(sameOwnerContainer({ ...labels, [LABEL_GENERATION]: 'nope' }, owner)).toBe(false)
        expect(sameOwnerVolume(volumeLabels(owner), owner)).toBe(true)
        expect(volumeLabels(owner)[LABEL_ROLE]).toBe(ROLE_PROFILE)
        expect(volumeLabels(owner)[LABEL_NONCE]).toBeUndefined()
        expect(sameOwnerVolume({ ...volumeLabels(owner), [LABEL_AGENT]: 'other' }, owner)).toBe(false)
    })
})
