'use client'

export async function saveDesktopResultFile(name: string, bytes: Uint8Array): Promise<boolean> {
    const save = (window as Window & { desktopApp?: { saveResultFile?: (name: string, bytes: Uint8Array) => Promise<boolean> } }).desktopApp?.saveResultFile
    if (!save) throw new Error('Open this file in the Mac app to save it.')
    return await save(name, bytes) === true
}
