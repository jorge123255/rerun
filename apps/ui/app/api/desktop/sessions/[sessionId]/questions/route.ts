import { desktopQuestionAnswerSchema } from '@/lib/desktop/questions'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { answerDesktopQuestion, readDesktopQuestion } from '@/lib/desktop/server/questions'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ sessionId: string }> }

export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopQuestion(runtime, (await params).sessionId), { headers: { 'cache-control': 'no-store' } }))
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = desktopQuestionAnswerSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Answer or skip each question, or dismiss the question form.')
        return answerDesktopQuestion(runtime, (await params).sessionId, parsed.data)
    })
}
