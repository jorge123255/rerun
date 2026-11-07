'use client'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { entriesFromFileList, type UploadEntry } from '@/lib/files/upload'
import { FolderUpIcon, UploadIcon } from '@/lib/icons'
import { useRef } from 'react'

type FilesImportMenuProps = {
    onPick: (entries: UploadEntry[]) => void
    disabled?: boolean
}

/** Multi-file and folder picker. This is not the chat composer attachment control. */
export function FilesImportMenu({ onPick, disabled = false }: FilesImportMenuProps) {
    const fileInputRef = useRef<HTMLInputElement>(null)
    const folderInputRef = useRef<HTMLInputElement>(null)

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files
        if (files?.length) onPick(entriesFromFileList(files))
        event.target.value = ''
    }

    return (
        <>
            <input ref={fileInputRef} type="file" multiple className="hidden" data-testid="files-import-file-input" disabled={disabled} onChange={handleChange} />
            <input ref={folderInputRef} type="file" multiple className="hidden" data-testid="files-import-folder-input" disabled={disabled} onChange={handleChange} {...{ webkitdirectory: '' }} />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2 text-xs" title="Import" disabled={disabled}>
                        <UploadIcon className="size-3.5" />
                        Import
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem className="whitespace-nowrap" disabled={disabled} onSelect={() => fileInputRef.current?.click()}>
                        <UploadIcon />
                        Import files
                    </DropdownMenuItem>
                    <DropdownMenuItem className="whitespace-nowrap" disabled={disabled} onSelect={() => folderInputRef.current?.click()}>
                        <FolderUpIcon />
                        Import folder
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    )
}
