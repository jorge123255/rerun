// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopQuestionCard } from '../DesktopQuestionCard'

const recorder = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }))
vi.mock('@/lib/desktop/voice/useDesktopVoiceRecorder', () => ({
    useDesktopVoiceRecorder: () => ({ ...recorder, stream: null, getLiveState: () => ({ durationMs: 0 }) }),
}))
vi.mock('./DesktopVoiceRecorderBar', () => ({ DesktopVoiceRecorderBar: () => <span>Recording fixture</span> }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const question = { id: 'a'.repeat(64), messageId: 'message', toolCallId: 'call', questions: [{ question: 'Which choice?', options: ['First', 'Second'] }] }
const settings = () => Response.json(['search', 'embedding', 'transcription'].map(purpose =>
    ({ purpose, revision: 'fixture', configured: purpose === 'transcription' })))
let host: HTMLDivElement, root: Root
const button = (action: string) => host.querySelector<HTMLButtonElement>(`[data-hitl="${action}"]`)!
const click = (action: string) => act(async () => button(action).click())

beforeEach(() => {
    recorder.start.mockReset().mockResolvedValue(true)
    recorder.stop.mockReset().mockResolvedValue({
        blob: new Blob(['fixture'], { type: 'audio/webm' }), durationMs: 1000, levels: [],
        format: { mimeType: 'audio/webm', extension: 'webm', transcriptionFormat: 'webm' },
    })
    recorder.cancel.mockReset().mockResolvedValue(null)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
})
afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

const foreman = { chat: { workspaceId: '1', chatId: 'fmc_voiceoriginal' } }

test.each([
    { target: { sessionId: 'session-a' }, url: '/api/desktop/sessions/session-a/questions/transcribe', fields: {} },
    { target: foreman, url: '/api/desktop/foreman/questions/transcribe', fields: foreman },
])('records in $url and appends to typed text before explicit submit', async ({ target, url, fields }) => {
    const answer = vi.fn(async () => {})
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
        if (path === '/api/desktop/auxiliary') return settings()
        expect(path).toBe(url)
        expect(JSON.parse(String(init?.body))).toMatchObject({ ...fields, questionId: question.id, durationMs: 1000 })
        return Response.json({ transcript: 'voice words' })
    })
    vi.stubGlobal('fetch', fetcher)
    await act(async () => root.render(<DesktopQuestionCard question={question} voiceTarget={target} onAnswer={answer} />))
    expect(host.querySelector('textarea')).toBeNull()
    expect(button('record').getAttribute('aria-label')).toBe('Answer with your voice')
    await click('custom')
    await act(async () => {
        const textarea = host.querySelector('textarea')!
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Typed first')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('record')
    expect(recorder.start).toHaveBeenCalledOnce()
    expect(button('next').disabled).toBe(true)
    expect(button('skip').disabled).toBe(true)
    expect(button('option-0').getAttribute('aria-disabled')).toBe('true')
    await click('option-0')
    expect(answer).not.toHaveBeenCalled()
    await click('record-stop')
    expect(recorder.stop).toHaveBeenCalledOnce()
    expect(host.querySelector('textarea')?.value).toBe('Typed first voice words')
    expect(answer).not.toHaveBeenCalled()
    await click('next')
    expect(answer).toHaveBeenCalledExactlyOnceWith({ action: 'answer', questionId: question.id, requestId: expect.any(String), answers: [['Typed first voice words']] })
})

test('discards without transcription and ignores a late Chief of Staff response after changing chats', async () => {
    const { chat } = foreman
    let complete!: (response: Response) => void
    let signal: AbortSignal | undefined
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/desktop/auxiliary') return settings()
        expect(url).toBe('/api/desktop/foreman/questions/transcribe')
        expect(JSON.parse(String(init?.body))).toMatchObject({ chat, questionId: question.id })
        signal = init?.signal ?? undefined
        return new Promise<Response>(resolve => { complete = resolve })
    })
    vi.stubGlobal('fetch', fetcher)
    const answer = vi.fn()
    await act(async () => root.render(<DesktopQuestionCard question={question} voiceTarget={{ chat }} onAnswer={answer} />))
    await click('record')
    await click('record-discard')
    expect(recorder.cancel).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await click('record')
    await click('record-stop')
    expect(signal?.aborted).toBe(false)
    const replacement = { ...chat, workspaceId: '2' }
    await act(async () => root.render(<DesktopQuestionCard question={question} voiceTarget={{ chat: replacement }} onAnswer={answer} />))
    expect(signal?.aborted).toBe(true)
    await act(async () => complete(Response.json({ transcript: 'Late transcript' })))
    expect(host.querySelector('textarea')?.value).toBe('')
    expect(answer).not.toHaveBeenCalled()
})
