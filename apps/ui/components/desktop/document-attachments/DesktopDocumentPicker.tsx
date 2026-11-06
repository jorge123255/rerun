'use client'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { PaperclipIcon } from '@/lib/icons'
import { useRef } from 'react'

export function DesktopDocumentPicker({ onFiles, disabled = false }: {
    onFiles: (files: File[]) => void
    disabled?: boolean
}) {
    const inputRef = useRef<HTMLInputElement>(null)
    return <>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={event => {
            const files = Array.from(event.currentTarget.files ?? [])
            if (files.length) onFiles(files)
            event.currentTarget.value = ''
        }} />
        <span onDragOver={event => event.preventDefault()} onDrop={event => {
            event.preventDefault()
            const files = Array.from(event.dataTransfer.files)
            if (files.length) onFiles(files)
        }} onPaste={event => {
            const files = Array.from(event.clipboardData.files)
            if (files.length) {
                event.preventDefault()
                onFiles(files)
            }
        }}>
            <PromptInputButton tooltip="Attach files" aria-label="Attach files" disabled={disabled} onClick={() => inputRef.current?.click()}><PaperclipIcon className="size-4" /></PromptInputButton>
        </span>
    </>
}
