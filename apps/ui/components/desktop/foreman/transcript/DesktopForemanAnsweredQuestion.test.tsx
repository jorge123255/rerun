// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { DesktopAnsweredQuestionRecap } from '@/lib/desktop/foreman/answered-question-recap'
import { DesktopForemanAnsweredQuestion } from './DesktopForemanAnsweredQuestion'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const recap = (over: Partial<DesktopAnsweredQuestionRecap> = {}): DesktopAnsweredQuestionRecap => ({
    key: JSON.stringify(['question-message', 'ask-call']),
    sourceMessageId: 'question-message', toolCallId: 'ask-call',
    questions: [
        { question: 'Which color?', options: ['Red', 'Blue'], multiple: false, answers: ['Blue'] },
        { question: 'Anything else?', options: [], multiple: false, answers: [] },
    ],
    ...over,
})

it('reopens saved question labels and selections read-only, with no controls or effects', async () => {
    const network = vi.fn(() => { throw new Error('No recap effects permitted') })
    vi.stubGlobal('fetch', network)
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    try {
        await act(async () => root.render(<DesktopForemanAnsweredQuestion recaps={[recap()]} />))
        expect(host.textContent).toContain('Which color?')
        expect(host.textContent).toContain('Blue')
        expect(host.textContent).toContain('Anything else?')
        expect(host.textContent).toContain('Skipped')
        expect(host.querySelector('button, a, input, textarea, form')).toBeNull()
        expect(network).not.toHaveBeenCalled()

        await act(async () => root.render(<DesktopForemanAnsweredQuestion recaps={[]} />))
        expect(host.querySelector('[data-foreman-answered-question]')).toBeNull()
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})
