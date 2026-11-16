// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import type { DesktopDocumentAttachment } from '@rerun/contracts'
import { DesktopDocumentChips, desktopDocumentSavingStatus } from './DesktopDocumentChips'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const MB = 1024 * 1024, scope = { agentId: 'owner', tabUid: 'tab' }
const row = (id: string, name: string, byteLength: number, patch: Partial<DesktopDocumentAttachment> = {}): DesktopDocumentAttachment => ({ attachmentId: id, scope, name, kind: 'binary', mimeType: 'application/zip', byteLength, sha256: 'a'.repeat(64),
    conversion: { mode: 'unsupported', state: 'pending' }, admitted: false, selected: true, uploaded: false, position: 0, revision: id, createdAt: 'now', updatedAt: 'now', ...patch })
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = '' })
const render = async (attachments: DesktopDocumentAttachment[], progress?: Record<string, number>) => {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopDocumentChips attachments={attachments} progress={progress} onRetry={() => {}} onRemove={() => {}} />))
}

it('shows how far a large upload is, then that the file is saved to Files, with no preview of its bytes', async () => {
    const large = row('large', 'backup.zip', 90 * MB), small = row('small', 'notes.zip', 2 * MB)
    await render([large, small], { large: 0.42 })
    expect(document.body.textContent).toContain('Uploading 42%')
    const bar = document.querySelector('[role="progressbar"]')!
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-label')]).toEqual(['42', 'Uploading backup.zip'])
    // A small file is saved in one step and has no percentage.
    expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(1)
    expect(document.body.textContent).toContain('2.0 MB · Saving')
    const ready = { uploaded: true, conversion: { mode: 'staged-file' as const, state: 'ready' as const, stagedRef: 'chat-uploads/x-backup.zip' } }
    await render([{ ...large, ...ready }, { ...small, ...ready }])
    expect(document.querySelector('[role="progressbar"]')).toBeNull()
    expect(document.body.textContent).toContain('Ready · saved to Files')
    expect(document.querySelector('[aria-label="Preview backup.zip"]')).toBeNull()
    expect(document.querySelector('[aria-label="Preview notes.zip"]')).not.toBeNull()
    // A failed upload says so and offers the retry.
    await render([{ ...large, conversion: { mode: 'unsupported', state: 'failed', error: 'x' } }], {})
    expect(document.body.textContent).toContain('Failed')
    expect(document.querySelector('[aria-label="Retry backup.zip"]')).not.toBeNull()
})

it('keeps the percentage within 0 and 100', () => {
    expect([undefined, 0, 0.004, 0.999, 1, 7, -1].map(desktopDocumentSavingStatus)).toEqual(['Saving', 'Uploading 0%', 'Uploading 0%', 'Uploading 100%', 'Uploading 100%', 'Uploading 100%', 'Uploading 0%'])
})
