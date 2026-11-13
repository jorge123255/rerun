// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopPendingQuestion, DesktopQuestionAnswer } from '@/lib/desktop/questions'
import { questionDocumentTabUid } from '@/lib/desktop/question-documents'
import { foremanDocumentScope, type DesktopDocumentAttachment } from '@rerun/contracts'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages, type DesktopLanguage } from '@/lib/desktop/locale'
import { DesktopLocale } from './DesktopLocale'
import { DesktopQuestionCard } from './DesktopQuestionCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const question: DesktopPendingQuestion = {
    id: 'a'.repeat(64), messageId: 'message-a', toolCallId: 'tool-a',
    questions: [{ question: 'Which color?', options: ['Blue', 'Red'] }],
}
const requestId = 'd04a4023-95c0-4cff-b380-69faec305b14'
const roots: Root[] = []

function mount() {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    return root
}

async function click(selector: string) {
    const target = document.querySelector<HTMLElement>(selector)
    expect(target).not.toBeNull()
    await act(async () => { target!.click() })
}

async function enter(value: string) {
    const textarea = document.querySelector('textarea')!
    expect(textarea).not.toBeNull()
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => { root.unmount() })
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

test('uses the original option form and submits an authoritative answer only once', async () => {
    let finish!: () => void
    const onAnswer = vi.fn((_payload: DesktopQuestionAnswer) => new Promise<void>(resolve => { finish = resolve }))
    const root = mount()
    await act(async () => { root.render(<DesktopQuestionCard question={question} onAnswer={onAnswer} />) })
    const option = document.querySelector<HTMLElement>('[data-hitl="option-0"]')!
    await act(async () => { option.click(); option.click() })
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer.mock.calls[0][0]).toEqual({ questionId: question.id, requestId: expect.any(String), action: 'answer', answers: [['Blue']] })
    await act(async () => { finish() })
    await click('[data-hitl="option-0"]')
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(document.querySelector('input[type="file"]')).toBeNull()
})

test('Enter confirms an in-progress input-method composition before submitting the final answer', async () => {
    const onAnswer = vi.fn(async (_payload: DesktopQuestionAnswer) => {})
    const root = mount()
    await act(async () => {
        root.render(<DesktopQuestionCard question={{ ...question, questions: [{ question: 'What should I call this?', options: [] }] }}
            onAnswer={onAnswer} />)
    })
    const textarea = document.querySelector('textarea')!
    const pressEnter = async (isComposing: boolean) => {
        const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing, bubbles: true, cancelable: true })
        await act(async () => { textarea.dispatchEvent(event) })
        return event
    }
    await enter('とうきょう')
    expect((await pressEnter(true)).defaultPrevented).toBe(false)
    expect(onAnswer).not.toHaveBeenCalled()
    await enter('東京')
    expect((await pressEnter(false)).defaultPrevented).toBe(true)
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ questionId: question.id, requestId: expect.any(String), action: 'answer', answers: [['東京']] })
})

test.each([
    ['text', false], ['image', false], ['text', true], ['image', true],
] as const)('restores a %s attachment and submits a file-only answer (Chief of Staff: %s)', async (kind, foreman) => {
    const scope = foreman ? foremanDocumentScope({ workspaceId: '1', chatId: 'fmc_filefixture' }, 'saved-chat', question.id)
        : { agentId: 'coworker', tabUid: questionDocumentTabUid(question.id), sessionId: 'saved-chat' }
    const content = 'Résumé <script>do not execute</script>'
    const bytes = new TextEncoder().encode(content)
    const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
    const saved: DesktopDocumentAttachment = {
        attachmentId: crypto.randomUUID(), scope, name: kind === 'image' ? 'notes.png' : 'notes.txt', mimeType: kind === 'image' ? 'image/png' : 'text/plain', kind, byteLength: bytes.length,
        sha256, conversion: { mode: kind === 'image' ? 'image' : 'plain-text', state: 'ready' }, uploaded: true, selected: true,
        admitted: false, position: 0, revision: crypto.randomUUID(), createdAt: '', updatedAt: '',
    }
    const admit = vi.fn()
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        const endpoint = foreman ? '/api/desktop/foreman/document-attachments' : '/api/desktop/coworkers/coworker/document-attachments'
        if (init.method === 'POST') {
            expect(url).toBe(endpoint)
            const payload = JSON.parse(String(init.body))
            admit(payload)
            return Response.json({ allowed: true, admissionId: payload.admissionId, references: [], inputs: [] })
        }
        const list = `${endpoint}?${new URLSearchParams({ tabUid: scope.tabUid, sessionId: scope.sessionId!, ...('questionId' in scope && scope.questionId ? { questionId: scope.questionId } : {}) })}`
        if (url !== list) {
            expect(url).toBe(`${list}&${new URLSearchParams({ attachmentId: saved.attachmentId, sha256, view: 'read' })}`)
            return new Response(bytes, { headers: { 'content-type': 'text/plain', 'x-rerun-document-sha256': sha256 } })
        }
        return Response.json({ attachments: [saved] })
    })
    const onAnswer = vi.fn(async (_payload: DesktopQuestionAnswer) => {})
    const root = mount()
    await act(async () => {
        root.render(<DesktopQuestionCard question={{ ...question, questions: [{ question: 'Which notes?', options: [] }] }}
            documentScope={scope} onAnswer={onAnswer} />)
    })
    expect(document.querySelector('[data-hitl="attach"]')).not.toBeNull()
    expect(document.body.textContent).toContain(saved.name)
    if (kind === 'image') {
        expect(document.querySelector<HTMLInputElement>('input[type=file]')?.accept).toContain('.png')
        expect(document.querySelector('img')?.getAttribute('src')).toContain('view=preview')
    } else {
        await click('[aria-label="Preview notes.txt"]')
        await vi.waitFor(() => expect(document.querySelector('[role="dialog"] pre')?.textContent).toBe(content))
        expect(document.querySelector('[role="dialog"] script')).toBeNull()
        expect(onAnswer).not.toHaveBeenCalled()
        await click('[data-slot="dialog-close"]')
    }
    await click('[data-hitl="next"]')
    const documents = { scope, attachmentIds: [saved.attachmentId], admissionId: expect.any(String) }
    expect(admit).toHaveBeenCalledExactlyOnceWith({ ...scope, operation: 'admission', attachmentIds: documents.attachmentIds, admissionId: documents.admissionId })
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ action: 'answer', questionId: question.id, requestId: expect.any(String), answers: [[]], documents })
})

test('a failed answer keeps the form editable and reuses only the same canonical intent ID', async () => {
    const onAnswer = vi.fn(async (_payload: DesktopQuestionAnswer) => { throw new Error('Connection interrupted') })
    const root = mount()
    await act(async () => { root.render(<DesktopQuestionCard question={{ ...question, questions: [{ question: 'Which color?', options: [] }] }} onAnswer={onAnswer} />) })
    await enter('  Blue  ')
    await click('[aria-label="Submit answers"]')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Connection interrupted')
    expect(document.querySelector('textarea')?.value).toBe('  Blue  ')
    await enter('Blue')
    await click('[aria-label="Submit answers"]')
    expect(onAnswer.mock.calls[1][0]).toEqual(onAnswer.mock.calls[0][0])
    await enter('Red')
    await click('[aria-label="Submit answers"]')
    expect(onAnswer.mock.calls[2][0].requestId).not.toBe(onAnswer.mock.calls[0][0].requestId)
    await enter('Blue')
    await click('[aria-label="Submit answers"]')
    expect(onAnswer.mock.calls[3][0]).toEqual(onAnswer.mock.calls[0][0])
})

test('a saved answer shows safe text and retries its exact persisted payload without a blank form', async () => {
    const attempt = { action: 'answer' as const, answers: [['<img src=x onerror=alert(1)>']], requestId }
    const saved = { ...question, attempt }
    let finish!: () => void
    const onAnswer = vi.fn((_payload: DesktopQuestionAnswer) => new Promise<void>(resolve => { finish = resolve }))
    const root = mount()
    await act(async () => { root.render(<DesktopQuestionCard question={saved} onAnswer={onAnswer} />) })
    expect(document.body.textContent).toContain(attempt.answers[0][0])
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-hitl]')).toBeNull()
    const retry = document.querySelector('button')!
    expect(retry.textContent).toBe('Retry answer')
    await act(async () => { retry.click(); retry.click() })
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ ...attempt, questionId: question.id })
    await act(async () => { finish() })
    expect(retry.disabled).toBe(true)
    expect(document.body.textContent).toContain('Answer sent.')
})

test('a restored cancellation retries its saved ID and cannot answer the dismissed form', async () => {
    const attempt = { action: 'cancel' as const, requestId }
    const onAnswer = vi.fn(async (_payload: DesktopQuestionAnswer) => {})
    const root = mount()
    await act(async () => { root.render(<DesktopQuestionCard question={{ ...question, attempt }} onAnswer={onAnswer} />) })
    expect(document.querySelector('[data-hitl]')).toBeNull()
    expect(document.querySelector('button')?.textContent).toBe('Retry cancellation')
    await click('button')
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ ...attempt, questionId: question.id })
})

test('failed cancellation releases the wrapper retry latch despite the original synchronous cancel callback', async () => {
    const onAnswer = vi.fn(async (_payload: DesktopQuestionAnswer) => {}).mockRejectedValueOnce(new Error('Could not confirm cancellation'))
    const root = mount()
    await act(async () => { root.render(<DesktopQuestionCard question={question} onAnswer={onAnswer} />) })
    await click('[aria-label="Dismiss questions"]')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Could not confirm cancellation')
    expect(document.querySelector('button')?.textContent).toBe('Retry cancellation')
    const first = onAnswer.mock.calls[0][0]
    expect(first.action).toBe('cancel')
    await click('button')
    expect(onAnswer).toHaveBeenCalledTimes(2)
    expect(onAnswer.mock.calls[1][0]).toEqual(first)
    expect(document.querySelector('[role="alert"]')).toBeNull()
})

test('disabled entry and recovery controls never dispatch an answer', async () => {
    const onAnswer = vi.fn(async (_payload: DesktopQuestionAnswer) => {})
    const root = mount()
    await act(async () => { root.render(<DesktopQuestionCard question={question} disabled onAnswer={onAnswer} />) })
    await click('[data-hitl="option-0"]')
    await click('[aria-label="Dismiss questions"]')
    await act(async () => { root.render(<DesktopQuestionCard question={{ ...question, attempt: { action: 'cancel', requestId } }} disabled onAnswer={onAnswer} />) })
    await click('button')
    expect(onAnswer).not.toHaveBeenCalled()
})

test('a different question has an independent intent and never receives a late prior error', async () => {
    let reject!: (cause: Error) => void
    const onAnswer = vi.fn((_payload: DesktopQuestionAnswer) => new Promise<void>((_resolve, fail) => { reject = fail }))
    const nextAnswer = vi.fn(async (_payload: DesktopQuestionAnswer) => {})
    const root = mount()
    await act(async () => { root.render(<DesktopQuestionCard question={question} onAnswer={onAnswer} />) })
    await click('[data-hitl="option-0"]')
    const next = { ...question, id: 'b'.repeat(64), messageId: 'message-b', toolCallId: 'tool-b' }
    await act(async () => { root.render(<DesktopQuestionCard question={next} onAnswer={nextAnswer} />) })
    await act(async () => { reject(new Error('Old question failed')) })
    expect(document.querySelector('[role="alert"]')).toBeNull()
    await click('[data-hitl="option-0"]')
    expect(nextAnswer.mock.calls[0][0].questionId).toBe(next.id)
    expect(nextAnswer.mock.calls[0][0].requestId).not.toBe(onAnswer.mock.calls[0][0].requestId)
})


test('French question controls preserve the question text and the exact Skip intent', async () => {
    const language: DesktopLanguage = { locale: 'fr', preference: 'fr', messages: desktopMessages('fr', await loadMessages('fr')) }
    const onAnswer = vi.fn(async (_payload: DesktopQuestionAnswer) => {})
    const root = mount()
    await act(async () => {
        root.render(<DesktopLocale initial={language}>
            <DesktopQuestionCard question={question} onAnswer={onAnswer} />
        </DesktopLocale>)
    })
    expect(document.body.textContent).toContain('Which color?')
    expect(document.querySelector('[data-hitl="skip"]')?.textContent?.trim()).toBe(language.messages.questionForm.skip)
    expect(document.querySelector('[data-hitl="dismiss"]')?.getAttribute('aria-label')).toBe(language.messages.questionForm.dismiss)
    expect(document.querySelector('[data-hitl="next"]')?.getAttribute('aria-label')).toBe(language.messages.questionForm.submit)
    await click('[data-hitl="skip"]')
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ questionId: question.id, requestId: expect.any(String), action: 'answer', answers: [[]] })
})
