import { desktopRoute } from '@/lib/desktop/server/http'
import { createDesktopWorkspaceRoutinesApi } from '@/lib/desktop/server/workspace-routines/api'
import { desktopWorkspaceRoutinesAuthority } from '@/lib/desktop/server/workspace-routines/runtime'
export const dynamic = 'force-dynamic'
export function GET(request: Request) { return desktopRoute(request, async runtime => createDesktopWorkspaceRoutinesApi(await desktopWorkspaceRoutinesAuthority(runtime)).GET(request)) }
export function POST(request: Request) { return desktopRoute(request, async runtime => createDesktopWorkspaceRoutinesApi(await desktopWorkspaceRoutinesAuthority(runtime)).POST(request)) }
