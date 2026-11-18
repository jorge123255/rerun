import { desktopRoute } from '@/lib/desktop/server/http'
import { phoneSettingsMacRequest, phoneSettingsRefusal, readPhoneCoworkerSettings } from '@/lib/desktop/server/phone-coworker-settings'
import { phoneSettingsOwner } from './owner'

export const dynamic = 'force-dynamic'

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const owner = await phoneSettingsOwner(runtime, request)
        try {
            const view = await readPhoneCoworkerSettings(owner, phoneSettingsMacRequest(runtime, request.signal))
            return Response.json(view, { headers: { 'cache-control': 'no-store' } })
        } catch (error) { return phoneSettingsRefusal(error) }
    })
}
