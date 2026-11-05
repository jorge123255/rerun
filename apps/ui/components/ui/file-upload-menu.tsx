'use client'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { entriesFromFileList, type UploadEntry } from '@/lib/files/upload'
import { FolderUpIcon, UploadIcon } from '@/lib/icons'
import { useRef } from 'react'

type FileUploadMenuProps = {
    onPick: (entries: UploadEntry[]) => void
    disabled?: boolean
}

// Picking files no longer blocks: the upload reports itself in the tray, so this stays a plain
// trigger with no pending state of its own.
export function FileUploadMenu({ onPick, disabled = false }: FileUploadMenuProps) {
    const fileInputRef = useRef<HTMLInputElement>(null)
    const folderInputRef = useRef<HTMLInputElement>(null)

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files
        if (!disabled && files?.length) onPick(entriesFromFileList(files))
        e.target.value = ''
    }

    return (
        <>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleChange} />
            <input ref={folderInputRef} type="file" multiple className="hidden" onChange={handleChange} {...{ webkitdirectory: '' }} />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" title="Upload" disabled={disabled}>
                        <UploadIcon className="size-3.5" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem className="whitespace-nowrap" onSelect={() => fileInputRef.current?.click()}>
                        <UploadIcon />
                        Upload files
                    </DropdownMenuItem>
                    <DropdownMenuItem className="whitespace-nowrap" onSelect={() => folderInputRef.current?.click()}>
                        <FolderUpIcon />
                        Upload folder
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    )
}
