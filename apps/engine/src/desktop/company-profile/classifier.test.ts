import { describe, expect, it } from 'vitest'
import type { CompanyBriefModelRef, DesktopCompanyProfileEngineDecideInput } from '@rerun/contracts'
import { decideCompanyIndustry } from './classifier.ts'
import type { CompanyProfileInferenceAdapter } from './model.ts'

const model: CompanyBriefModelRef = { connectionId: 'selected', provider: 'codex', model: 'purpose-model', source: 'workspace', agentId: null }
const identity = { chat: { workspaceId: 'ws-1', chatId: 'fmc_classifier1' }, draftRevision: 2, inputDigest: 'a'.repeat(64) }
const input: DesktopCompanyProfileEngineDecideInput = { requestId: '7a6a13ef-035f-4f0d-980e-2c1f3c628002', identity, input: 'acme.example', model }

function adapter(answer: string | null, confirm = true): CompanyProfileInferenceAdapter {
    return { confirm: async () => confirm, complete: async () => answer }
}

describe('bounded company industry classifier', () => {
    it('returns a typed decision from the configured purpose model', async () => {
        const result = await decideCompanyIndustry(input, adapter('{"industry":"saas","confidence":0.91}'))
        expect(result).toMatchObject({ status: 'succeeded', decision: { industry: 'saas', confidence: 0.91, source: 'inference' }, inference: null })
    })

    it('abstains below the confidence floor', async () => {
        const result = await decideCompanyIndustry(input, adapter('{"industry":"other","confidence":0.49}'))
        expect(result).toEqual({ status: 'unavailable', reason: 'low_confidence' })
    })

    it('does not call a model when the exact configuration is unavailable', async () => {
        let calls = 0
        const unavailable: CompanyProfileInferenceAdapter = { confirm: async () => false, complete: async () => { calls++; return null } }
        expect(await decideCompanyIndustry(input, unavailable)).toEqual({ status: 'unavailable', reason: 'missing_configuration' })
        expect(calls).toBe(0)
    })

    it('bounds a hanging model call with a deadline', async () => {
        const hanging: CompanyProfileInferenceAdapter = {
            confirm: async () => true,
            complete: ({ signal }) => new Promise<string | null>(resolve => {
                signal.addEventListener('abort', () => resolve(null), { once: true })
            }),
        }
        const result = await decideCompanyIndustry(input, hanging, { deadlineMs: 1 })
        expect(result).toEqual({ status: 'unavailable', reason: 'timeout' })
    })

    it('reports cancellation instead of publishing a late answer', async () => {
        const controller = new AbortController()
        const waiting: CompanyProfileInferenceAdapter = {
            confirm: async () => true,
            complete: async ({ signal }) => {
                controller.abort()
                signal.throwIfAborted()
                return '{"industry":"saas","confidence":0.99}'
            },
        }
        expect(await decideCompanyIndustry(input, waiting, { signal: controller.signal })).toEqual({ status: 'cancelled' })
    })

    it('fails closed for malformed or unknown categories', async () => {
        expect(await decideCompanyIndustry(input, adapter('not json'))).toEqual({ status: 'error', reason: 'invalid_model_response' })
        expect(await decideCompanyIndustry(input, adapter('{"industry":"invented","confidence":1}'))).toEqual({ status: 'error', reason: 'invalid_model_response' })
    })
})
