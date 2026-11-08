import { fxBoardCameraHandlers } from '@/lib/desktop/fx-repairs/board-camera-store'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ workspaceId: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
    return fxBoardCameraHandlers.read(request, (await context.params).workspaceId)
}

export async function PUT(request: Request, context: Context): Promise<Response> {
    return fxBoardCameraHandlers.write(request, (await context.params).workspaceId)
}
