import { GETDesktopWorkRoutine, POSTDesktopWorkRoutine } from '@/lib/desktop/server/work-register/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = GETDesktopWorkRoutine
export const POST = POSTDesktopWorkRoutine
