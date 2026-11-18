import { DesktopHttpError } from '../auth'

/**
 * The refusal a coworker whose setup is not finished or skipped gives to any other conversation.
 * Its own class so a caller that names the coworker (a coworker call) can say so in its own words
 * without reading the message text. `started`: a setup chat is claimed and waits for the person.
 */
export class DesktopSetupPendingError extends DesktopHttpError {
    constructor(readonly started: boolean) {
        super(409, 'Start or continue this coworker’s setup before opening another conversation.')
        this.name = 'DesktopSetupPendingError'
    }
}
