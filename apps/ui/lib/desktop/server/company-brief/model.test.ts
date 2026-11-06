import { expect, it } from 'vitest'
import { explicitCompanyBriefModel, type CompanyBriefModelChoice } from './model'

const choice = (patch: Partial<CompanyBriefModelChoice['effective']> = {}): CompanyBriefModelChoice => ({
    effective: { source: 'workspace', connectionId: 'conn', provider: 'openai', model: 'gpt-test', available: true, ...patch },
    workspace: { connectionId: 'conn', model: 'gpt-test' },
    coworker: null,
})

it('uses the saved workspace or coworker model and refuses a fallback', () => {
    expect(explicitCompanyBriefModel(choice(), null)).toEqual({ ok: true, model: { connectionId: 'conn', provider: 'openai', model: 'gpt-test', source: 'workspace', agentId: null } })
    const coworker = explicitCompanyBriefModel(choice({ source: 'coworker' }), 'agent-1')
    if (!coworker.ok) throw new Error('coworker model')
    expect(coworker.model.source).toBe('coworker')
    const missing = explicitCompanyBriefModel(choice({ available: false }), null)
    if (missing.ok) throw new Error('missing model')
    expect(missing.code).toBe('missing_model')
    const rerun = explicitCompanyBriefModel(choice({ provider: 'rerun', model: 'balanced' }), null)
    if (rerun.ok) throw new Error('rerun provider')
    expect(rerun.code).toBe('provider_unsupported')
    const conversation = choice({ source: 'conversation', connectionId: 'other', model: 'gpt-other' })
    conversation.workspace = { connectionId: 'conn', model: 'gpt-test' }
    const refused = explicitCompanyBriefModel(conversation, 'agent-1')
    if (refused.ok) throw new Error('conversation model')
    expect(refused.code).toBe('conversation_model_unverified')
})


it('keeps the exact connected Codex model for synthesis', () => {
    const current = choice({ provider: 'codex', model: 'gpt-6.1-terra' })
    current.workspace = { connectionId: 'conn', model: 'gpt-6.1-terra' }
    expect(explicitCompanyBriefModel(current, null)).toEqual({ ok: true, model: { connectionId: 'conn', provider: 'codex', model: 'gpt-6.1-terra', source: 'workspace', agentId: null } })
})
