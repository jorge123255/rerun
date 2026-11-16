// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopBackupModel } from './DesktopBackupModel'

const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals() })

const options = [
    { connectionId: 'mac-claude', name: 'Claude', plan: true, models: [{ id: 'claude-opus-5-5', label: 'Opus' }] },
    { connectionId: 'openai-key', name: 'OpenAI', plan: false, models: [{ id: 'gpt-paid', label: 'GPT paid' }] },
]

test('the backup model is off by default, says a key is paid per token, and saves exactly the picked pair', async () => {
    const saved = { backup: { connectionId: 'openai-key', model: 'gpt-paid' }, options }
    const fetchMock = vi.fn(async () => Response.json(saved))
    vi.stubGlobal('fetch', fetchMock)
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopBackupModel initial={{ backup: null, options }} />))

    const select = document.querySelector<HTMLSelectElement>('#desktop-backup-model')!
    expect(select.value).toBe('')
    expect(select.options[0]!.textContent).toBe('No backup: wait for the plan to reset')
    expect(document.body.textContent).toContain('A key is billed per token: choosing one here means you agree to pay for what runs on it.')
    expect([...document.querySelectorAll('optgroup')].map(group => group.label)).toEqual(['Claude · monthly plan', 'OpenAI · billed per token or local'])
    // Nothing is asked of the server until the owner picks.
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => { select.value = JSON.stringify(['openai-key', 'gpt-paid']); select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(fetchMock).toHaveBeenCalledWith('/api/desktop/settings/backup-model', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ backup: { connectionId: 'openai-key', model: 'gpt-paid' } }) }))
    expect(document.body.textContent).toContain('OpenAI is not a monthly plan. If it is a key, work that runs on it is billed per token.')
})
