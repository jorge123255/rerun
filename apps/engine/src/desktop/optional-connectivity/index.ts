import { createIncomingWebhookAdmission, type WebhookDedupPort, type WebhookSecretPort } from './incoming-webhook.js'
import { createPublicSharePolicy } from './public-share.js'
import { createRemoteGatewayAdmission, type RemoteGatewaySnapshotPort } from './remote-gateway.js'

const disabledSnapshot: RemoteGatewaySnapshotPort = { async read() { return null } }
const disabledSecret: WebhookSecretPort = { async read() { return null } }
const disabledDedup: WebhookDedupPort = { async find() { return { state: 'unknown' } } }

/** Local operation stays available. Every optional module is disabled until root passes enabled: true. */
export function createOptionalConnectivityFoundation(ports?: {
    remote?: RemoteGatewaySnapshotPort
    secrets?: WebhookSecretPort
    deliveries?: WebhookDedupPort
}) {
    return {
        activation: { remoteGateway: false, publicShare: false, incomingWebhook: false } as const,
        remote: createRemoteGatewayAdmission(ports?.remote ?? disabledSnapshot),
        share: createPublicSharePolicy(),
        webhook: createIncomingWebhookAdmission({
            secrets: ports?.secrets ?? disabledSecret,
            deliveries: ports?.deliveries ?? disabledDedup,
        }),
    }
}
