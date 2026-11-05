import { vi } from 'vitest'

const state = vi.hoisted(() => ({ created: 0, version: 0, listed: 0 }))

vi.mock('./docker-cli.js', () => ({
    createDockerCli: () => {
        state.created += 1
        return {
            version: async () => {
                state.version += 1
                return { kind: 'missing' }
            },
            listScreens: async () => {
                state.listed += 1
                return []
            },
        }
    },
}))

const { beforeEach, describe, expect, it } = await import('vitest')
const { reconcileIsolatedScreens, shutdownIsolatedScreens } = await import('./index.js')

beforeEach(() => {
    state.created = 0
    state.version = 0
    state.listed = 0
})

describe('isolated screen hooks', () => {
    it('does not construct docker until a hook runs', async () => {
        expect(state.created).toBe(0)
        const signal = new AbortController().signal
        await expect(shutdownIsolatedScreens(signal)).resolves.toEqual({ stopped: 0, skipped: 0, prerequisite: 'docker-missing' })
        expect(state.created).toBe(1)
        expect(state.version).toBe(1)
        expect(state.listed).toBe(0)
        await expect(reconcileIsolatedScreens('11111111-1111-4111-8111-111111111111', signal)).resolves.toMatchObject({ prerequisite: 'docker-missing' })
        expect(state.listed).toBe(0)
    })
})
