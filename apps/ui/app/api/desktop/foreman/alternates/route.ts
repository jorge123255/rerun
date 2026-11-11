import { bindForemanAlternates } from '@/lib/desktop/server/foreman-alternates/binding'
import { createForemanAlternateHandler } from '@/lib/desktop/server/foreman-alternates/handler'

export const runtime = 'nodejs'
export const POST = createForemanAlternateHandler(bindForemanAlternates)
