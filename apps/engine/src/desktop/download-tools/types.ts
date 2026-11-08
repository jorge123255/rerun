export type PublicBinaryRead = {
    status: number
    finalUrl: string
    contentType: string | null
    bytes: Uint8Array
}

/** Must already have passed publicUrl. Hostname admission (DNS) belongs inside the real reader. */
export type PublicBinaryReader = (
    url: URL,
    signal: AbortSignal,
    assertPermission: () => Promise<void>,
) => Promise<PublicBinaryRead>

export type DownloadResult = {
    text: string
    failed: boolean
    saved: boolean
}
