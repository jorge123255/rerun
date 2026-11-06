import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EMPTY_DRAFT } from '@rerun/contracts'

import { createDesktopForemanIntakeService, createMemoryDesktopForemanIntakeStore } from './service'

const chat = { workspaceId: 'ws-1', chatId: 'fmc_servicetest1' }

describe('desktop foreman intake service ports', () => {
    it('fails closed for industry and site when authorities are missing', async () => {
        const store = createMemoryDesktopForemanIntakeStore()
        const service = createDesktopForemanIntakeService({
            store,
            completion: null,
            industry: null,
            site: null,
            knownName: null,
        })
        expect(await service.decideIndustry('acme.com')).toBeNull()
        expect(service.analyzeSite('acme.com')).toEqual({
            started: false,
            missingAuthority: 'DesktopForemanIntakeSiteAuthority',
        })
        expect(await service.resolveKnownFirstName(chat)).toBeNull()
    })

    it('delegates industry/site when ports are bound', async () => {
        const store = createMemoryDesktopForemanIntakeStore()
        const analyze = vi.fn()
        const service = createDesktopForemanIntakeService({
            store,
            completion: null,
            industry: { decide: async () => 'saas' },
            site: { analyze },
            knownName: { readKnownFirstName: async () => 'Ada' },
        })
        expect(await service.decideIndustry('acme.com')).toBe('saas')
        expect(service.analyzeSite('acme.com')).toEqual({ started: true, missingAuthority: null })
        expect(analyze).toHaveBeenCalledWith('acme.com')
        expect(await service.resolveKnownFirstName(chat)).toBe('Ada')
        await store.save({
            chat,
            requestId: randomUUID(),
            baseRevision: 0,
            stepIndex: 0,
            draft: { ...EMPTY_DRAFT, companyUrl: 'acme.com' },
            decidedIndustry: 'saas',
            knownFirstName: 'Ada',
        })
    })
})
