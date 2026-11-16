import { describe, expect, it } from 'vitest'
import { chatErrorTitle, friendlyError } from '@rerun/contracts'
import { desktopForemanRunFailure, desktopForemanRunFailureSchema, desktopForemanRunFailureText } from './run-failure'

const NO_CREDIT = 'AI_APICallError: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'
const NOT_SCOPED = 'ProviderRefusedError: Provider returned error: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.'

describe('desktopForemanRunFailure', () => {
    it('names an Anthropic API account out of credit without passing the provider text on', () => {
        const failure = desktopForemanRunFailure(NO_CREDIT, 'conn')
        expect(failure).toEqual({ kind: 'usage_limit', connectionId: 'conn', detail: 'anthropic_credits' })
        expect(desktopForemanRunFailureSchema.parse(failure)).toEqual(failure)
        const text = desktopForemanRunFailureText(failure.detail)!
        expect(chatErrorTitle('usage_limit', text)).toBe('Anthropic API credits used up')
        expect(friendlyError(text)).toContain('Add credits in the Anthropic Console under Billing')
    })

    it('names an Anthropic key scoped to no workspace', () => {
        const failure = desktopForemanRunFailure(NOT_SCOPED, 'conn')
        expect(failure).toEqual({ kind: 'unauthorized', connectionId: 'conn', detail: 'anthropic_key_not_scoped' })
        const text = desktopForemanRunFailureText(failure.detail)!
        expect(chatErrorTitle('unauthorized', text)).toBe('Anthropic key not tied to a workspace')
        expect(friendlyError(text)).toContain('Create a key inside one workspace')
    })

    it('adds no detail to any other failure', () => {
        expect(desktopForemanRunFailure("You've hit your session limit", 'conn')).toEqual({ kind: 'usage_limit', connectionId: 'conn' })
        expect(desktopForemanRunFailure('invalid x-api-key', 'conn')).toEqual({ kind: 'unauthorized', connectionId: 'conn' })
        expect(desktopForemanRunFailure(null, 'conn')).toEqual({ kind: 'generic', connectionId: 'conn' })
        expect(desktopForemanRunFailureText(undefined)).toBeUndefined()
    })
})
