import type { ConnectionsList, DesktopCodexStatus } from '@rerun/contracts'

/** The device-code status is the sign-in screen's source. A provider snapshot failure must not hide it. */
export async function desktopCodexLoginBody(
    readStatus: () => Promise<DesktopCodexStatus>,
    readProviders: () => Promise<ConnectionsList>,
): Promise<{ status: DesktopCodexStatus; providers: ConnectionsList | null }> {
    const status = await readStatus()
    try {
        return { status, providers: await readProviders() }
    } catch {
        return { status, providers: null }
    }
}
