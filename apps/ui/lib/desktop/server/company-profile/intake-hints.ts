import 'server-only'
import type { DesktopForemanIntakeSaveInput } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { DesktopCompanyProfileBinding } from './binding'

export async function assertDesktopCompanyProfileIntakeHints(
    profile: DesktopCompanyProfileBinding,
    input: DesktopForemanIntakeSaveInput,
): Promise<void> {
    if (input.decidedIndustry) {
        const view = await profile.read(input.chat)
        const attempt = view.decision
        const decision = attempt?.status === 'succeeded' && attempt.outcome?.status === 'succeeded' ? attempt.outcome.decision : null
        if (!attempt || !view.decisionIdentity || attempt.identity.draftRevision !== input.baseRevision
            || attempt.identity.inputDigest !== view.decisionIdentity.inputDigest
            || decision?.source !== 'inference' || decision.industry !== input.decidedIndustry) {
            throw new DesktopHttpError(409, 'This automatic industry hint changed. Review the current company answer before saving.')
        }
    }
    if (input.knownFirstName) {
        const known = await profile.resolveKnownFirstName(input.chat)
        if (!known || known !== input.knownFirstName) {
            throw new DesktopHttpError(400, 'The local profile does not confirm this first name. Answer the original name question.')
        }
    }
}
