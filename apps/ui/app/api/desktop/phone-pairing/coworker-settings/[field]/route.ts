import { macPhoneCoworkerSettingsChangeSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { phoneSettingsMacRequest, phoneSettingsMethods, phoneSettingsRefusal, savePhoneCoworkerSettings } from '@/lib/desktop/server/phone-coworker-settings'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { phoneSettingsOwner } from '../owner'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ field: string }> }
async function write(request: Request, context: Context) {
    return desktopRoute(request, async runtime => {
        const { field } = await context.params
        if (!Object.hasOwn(phoneSettingsMethods, field) || phoneSettingsMethods[field as keyof typeof phoneSettingsMethods] !== request.method)
            throw new DesktopHttpError(404, 'Not found')
        const owner = await phoneSettingsOwner(runtime, request)
        const change = macPhoneCoworkerSettingsChangeSchema.safeParse({ field, body: await readDesktopJson(request, 640 * 1024) })
        if (!change.success) throw new DesktopHttpError(400, 'Invalid settings change')
        try {
            const receipt = await savePhoneCoworkerSettings(owner, change.data, phoneSettingsMacRequest(runtime, request.signal))
            return Response.json(receipt, { headers: { 'cache-control': 'no-store' } })
        } catch (error) { return phoneSettingsRefusal(error) }
    })
}

export { write as PATCH, write as PUT, write as POST }
