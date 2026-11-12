// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { AttachmentLightbox } from '@/components/chat/AttachmentLightbox'
import { DesktopWorkspaceAttachmentLightbox, type WorkspaceAttachmentSource } from './DesktopWorkspaceAttachmentLightbox'

vi.mock('@/app/api/_actions/file.actions', () => ({ readFileAction: vi.fn() }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const first = 'notes/Plan #1.md'
const second = 'notes/Follow up.txt'
let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
})

async function render(source: WorkspaceAttachmentSource, index = 0) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopWorkspaceAttachmentLightbox source={source} paths={[first, second]} index={index}
        onIndexChange={() => {}} onClose={() => {}} />))
}
const download = () => document.querySelector<HTMLButtonElement>('button[aria-label="Download"]')
const textResponse = (bytes: Uint8Array<ArrayBuffer> | string) => new Response(bytes, { headers: { 'content-type': 'text/plain; charset=utf-8' } })

test('saves the exact displayed saved-attachment bytes through the Mac dialog without refetching', async () => {
    const raw = new TextEncoder().encode('\uFEFFRésumé\r\n<svg>text</svg>\r\n')
    const fetch = vi.fn().mockResolvedValueOnce(textResponse(raw)).mockResolvedValueOnce(textResponse('Changed elsewhere'))
    const saveResultFile = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('desktopApp', { saveResultFile })
    await render({ sessionId: 'saved-chat', messageId: 'saved-message' })
    expect(document.querySelector('pre')?.textContent).toContain('Résumé')
    expect(document.querySelector('pre svg')).toBeNull()
    expect(document.querySelector('a[download]')).toBeNull()
    expect(download()?.disabled).toBe(false)
    await act(async () => download()!.click())
    expect(document.body.textContent).not.toContain('Saved')
    await act(async () => download()!.click())
    expect(document.body.textContent).toContain('Saved')
    expect(saveResultFile.mock.calls).toEqual([['Plan #1.md', raw], ['Plan #1.md', raw]])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/api/desktop/sessions/saved-chat/messages/saved-message/attachment?path=notes%2FPlan+%231.md',
        expect.objectContaining({ cache: 'no-store', redirect: 'error', credentials: 'same-origin' }))
})

test('changing source or attachment aborts the previous read and disables Save until the new bytes arrive', async () => {
    let finish!: (response: Response) => void
    const delayed = new Promise<Response>(resolve => { finish = resolve })
    const fetch = vi.fn().mockReturnValueOnce(delayed).mockResolvedValueOnce(textResponse('Second exact attachment'))
    const saveResultFile = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('desktopApp', { saveResultFile })
    await render({ agentId: 'draft-owner' })
    expect(download()?.disabled).toBe(true)
    const firstSignal = fetch.mock.calls[0][1].signal as AbortSignal
    await render({ sessionId: 'saved-chat', messageId: 'saved-message' }, 1)
    expect(firstSignal.aborted).toBe(true)
    await act(async () => finish(textResponse('Old draft')))
    expect(document.querySelector('pre')?.textContent).toBe('Second exact attachment')
    await act(async () => download()!.click())
    expect(saveResultFile).toHaveBeenCalledExactlyOnceWith('Follow up.txt', new TextEncoder().encode('Second exact attachment'))
})

test('switching chats with the same attachment path cannot save the old preview', async () => {
    let finish!: (response: Response) => void
    const fetch = vi.fn().mockResolvedValueOnce(textResponse('First chat'))
        .mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
    const saveResultFile = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('desktopApp', { saveResultFile })
    await render({ sessionId: 'first', messageId: 'message' })
    expect(download()?.disabled).toBe(false)
    await render({ sessionId: 'second', messageId: 'message' })
    expect(document.querySelector('pre')).toBeNull()
    expect(download()?.disabled).toBe(true)
    await act(async () => download()!.click())
    expect(saveResultFile).not.toHaveBeenCalled()
    await act(async () => finish(textResponse('Second chat')))
    await act(async () => download()!.click())
    expect(saveResultFile).toHaveBeenCalledExactlyOnceWith('Plan #1.md', new TextEncoder().encode('Second chat'))
})

test('refuses a failed or wrong-format read without opening a native save', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<html>unexpected</html>', { headers: { 'content-type': 'text/html' } }))
    const saveResultFile = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('desktopApp', { saveResultFile })
    await render({ agentId: 'draft-owner' })
    expect(document.body.textContent).toContain('This attachment could not be read.')
    expect(download()?.disabled).toBe(true)
    await act(async () => download()!.click())
    expect(saveResultFile).not.toHaveBeenCalled()
})

test('the browser lightbox still provides its original download link', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<AttachmentLightbox paths={[first]} index={0} rawUrlFor={() => '/file/owned'}
        readFile={async () => ({ content: 'Browser preview', truncated: false })} onIndexChange={() => {}} onClose={() => {}} />))
    expect(document.querySelector('a[download]')?.getAttribute('href')).toBe('/file/owned')
    expect(document.querySelector('pre')?.textContent).toBe('Browser preview')
})
