// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { QuestionForm, type QuestionFormHandle } from '../../../../../../packages/ui/src/chat/QuestionForm'
import { projectDesktopQuestionInput } from '@/lib/desktop/chat-interactions/questions'
import { DESCRIBED_QUESTION_BYTES } from '@/lib/desktop/chat-interactions/fixtures'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); document.body.innerHTML = '' })
test('real shared form displays original header/descriptions, submits only labels and blocks a double click', async () => {
    const host = document.body.appendChild(document.createElement('div')), root = createRoot(host), submit = vi.fn(async () => {})
    dispose = async () => { await act(async () => root.unmount()) }
    await act(async () => root.render(<QuestionForm inline questions={projectDesktopQuestionInput(DESCRIBED_QUESTION_BYTES)!.questions} onSubmit={submit} />))
    expect(host.textContent).toContain('Format'); expect(host.textContent).toContain('Easy to edit')
    const option = host.querySelector<HTMLElement>('[data-hitl="option-0"]')!
    await act(async () => { option.click(); option.click() })
    expect(submit).toHaveBeenCalledOnce(); expect(submit).toHaveBeenCalledWith([{ question: 'Choose a format', answers: ['Plain'] }])
    expect([...host.querySelectorAll('button')].every(b => b.type === 'button')).toBe(true)
})
test('legacy strings, custom text, Skip and dismissal keep their original controls', async () => {
    const host = document.body.appendChild(document.createElement('div')), root = createRoot(host), submit = vi.fn(), cancel = vi.fn()
    dispose = async () => { await act(async () => root.unmount()) }
    await act(async () => root.render(<QuestionForm inline questions={[{ question: 'Legacy?', options: ['Yes', 'No'] }]} onSubmit={submit} onCancel={cancel} />))
    expect(host.textContent).toContain('Something else')
    await act(async () => host.querySelector<HTMLElement>('[data-hitl="skip"]')!.click())
    expect(submit).toHaveBeenCalledWith([{ question: 'Legacy?', answers: [] }])
    await act(async () => root.render(<QuestionForm key="new" inline questions={[{ question: 'Legacy?', options: ['Yes', 'No'] }]} onSubmit={submit} onCancel={cancel} />))
    await act(async () => host.querySelector<HTMLElement>('[data-hitl="dismiss"]')!.click())
    expect(cancel).toHaveBeenCalledOnce()
})
test('custom answer survives a failed acknowledgement and retries without description text', async () => {
    const host = document.body.appendChild(document.createElement('div')), root = createRoot(host), ref = createRef<QuestionFormHandle>()
    const submit = vi.fn().mockRejectedValueOnce(Error('Lost acknowledgement')).mockResolvedValue(undefined)
    dispose = async () => { await act(async () => root.unmount()) }
    await act(async () => root.render(<QuestionForm ref={ref} inline questions={projectDesktopQuestionInput(DESCRIBED_QUESTION_BYTES)!.questions} onSubmit={submit} />))
    await act(async () => host.querySelector<HTMLElement>('[data-hitl="custom"]')!.click())
    await act(async () => ref.current!.sync('My Unicode answer 👋'))
    await act(async () => host.querySelector<HTMLElement>('[data-hitl="next"]')!.click())
    expect(host.querySelector('textarea')?.value).toBe('My Unicode answer 👋')
    await act(async () => host.querySelector<HTMLElement>('[data-hitl="next"]')!.click())
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0])
    expect(submit.mock.calls[1][0]).toEqual([{ question: 'Choose a format', answers: ['My Unicode answer 👋'] }])
})

test('puts the file picker in the footer even when the custom answer is closed', async () => {
    const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
    const attachments = { onPick: vi.fn(), onClear: vi.fn(), count: () => 0, render: () => null }
    dispose = async () => { await act(async () => root.unmount()) }
    await act(async () => root.render(<QuestionForm inline questions={[{ question: 'Choose a file', options: ['Later'] }]} attachments={attachments} onSubmit={vi.fn()} />))
    expect(host.querySelector('textarea')).toBeNull()
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    const picker = vi.spyOn(input, 'click').mockImplementation(() => {})
    const attach = host.querySelector<HTMLButtonElement>('[data-hitl="attach"]')!
    expect(attach.closest('div.flex.items-center')?.parentElement?.querySelector('[data-hitl="skip"]')).not.toBeNull()
    await act(async () => attach.click())
    expect(picker).toHaveBeenCalledOnce()
    const file = new File(['fixture'], 'answer.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(attachments.onPick).toHaveBeenCalledExactlyOnceWith(0, [file])
})
