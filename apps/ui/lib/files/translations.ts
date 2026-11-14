'use client'

import files from '@rerun/i18n/messages/en/files.json'
import ui from '@rerun/i18n/messages/en/ui.json'
import { createContext, useContext } from 'react'
import { createTranslator } from 'use-intl/core'

type FileMessages = { files: typeof files; upload: typeof ui.upload }

export function createFileTranslator(locale: string, messages: FileMessages) {
    return createTranslator({ locale, messages })
}

export const FileTranslations = createContext(createFileTranslator('en', { files, upload: ui.upload }))
export const useFileTranslations = () => useContext(FileTranslations)
