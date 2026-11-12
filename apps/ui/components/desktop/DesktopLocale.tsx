'use client'

import { BrainTranslations, createBrainTranslator } from '@/components/brain/brain-translations'
import { FileTranslations, createFileTranslator } from '@/lib/files/translations'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { desktopLocaleTag, desktopTranslator, englishDesktopLanguage, type DesktopLanguage } from '@/lib/desktop/locale'

const LocaleContext = createContext<{
    language: DesktopLanguage
    t: ReturnType<typeof desktopTranslator>
    setLanguage: (language: DesktopLanguage) => void
}>({
    language: englishDesktopLanguage,
    t: desktopTranslator(englishDesktopLanguage),
    setLanguage: () => {},
})

export function DesktopLocale({ initial, children }: { initial: DesktopLanguage; children: ReactNode }) {
    const [language, setLanguage] = useState(initial)
    const tag = desktopLocaleTag(language.locale)
    const brain = useMemo(() => createBrainTranslator(tag, language.messages.brain), [tag, language.messages.brain])
    const files = useMemo(() => createFileTranslator(tag, { files: language.messages.files, upload: language.messages.fileUpload }),
        [tag, language.messages.files, language.messages.fileUpload])
    const value = useMemo(() => ({ language, t: desktopTranslator(language), setLanguage }), [language])
    useEffect(() => {
        const original = document.documentElement.lang
        document.documentElement.lang = tag
        return () => { document.documentElement.lang = original }
    }, [tag])
    return (
        <LocaleContext.Provider value={value}>
            <BrainTranslations.Provider value={brain}>
                <FileTranslations.Provider value={files}>
                    <div className="contents" lang={tag}>{children}</div>
                </FileTranslations.Provider>
            </BrainTranslations.Provider>
        </LocaleContext.Provider>
    )
}

export const useDesktopLocale = () => useContext(LocaleContext)
