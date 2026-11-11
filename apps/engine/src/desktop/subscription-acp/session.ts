import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AcpPeer, isObject, SubscriptionAcpError, type AcpChannel } from './peer.js';

const TURN_TIMEOUT_MS = 5 * 60_000;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_REPLY_BYTES = 1024 * 1024;

const authParams = {
    'grok-build': { methodId: 'cached_token', _meta: { headless: true } },
    'kimi-code': { methodId: 'login' },
} as const;

const idSchema = z.string().min(1).max(512);
const optionSchema = z.object({ value: idSchema, name: z.string().min(1).max(512) });
const optionsSchema = z.union([
    z.array(optionSchema).max(128),
    z.array(z.object({ options: z.array(optionSchema).max(128) })).max(128)
        .transform((groups) => groups.flatMap((group) => group.options)),
]);
const selectorSchema = z.object({
    id: idSchema,
    category: z.enum(['model', 'thought_level']),
    currentValue: idSchema,
    options: optionsSchema,
});
const initializationSchema = z.object({
    protocolVersion: z.literal(1),
    authMethods: z.array(z.object({ id: idSchema })).max(64).nullish(),
});
const newSessionSchema = z.object({
    sessionId: idSchema,
    configOptions: z.unknown().optional(),
});
const promptResultSchema = z.object({
    stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']),
});

type Selector = z.infer<typeof selectorSchema>;
type Category = Selector['category'];
type StopReason = z.infer<typeof promptResultSchema>['stopReason'];

interface Selection {
    model?: string;
    reasoning?: string;
}

interface PromptOptions extends Selection {
    text: string;
    signal?: AbortSignal;
    onText?: (text: string) => void;
}

interface OpenOptions {
    provider: keyof typeof authParams;
    channel: AcpChannel;
    // The runtime must supply a private working directory and confine the provider process.
    cwd: string;
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const result = schema.safeParse(raw);
    if (!result.success) throw new SubscriptionAcpError('protocol');
    return result.data;
}

function readSelectors(raw: unknown): Selector[] {
    const options = parse(z.array(z.unknown()).max(64).nullish(), raw) ?? [];
    return options.flatMap((option) => {
        if (!isObject(option) || option.type !== 'select' ||
            (option.category !== 'model' && option.category !== 'thought_level')) return [];
        const selector = parse(selectorSchema, option);
        const ids = new Set(selector.options.map(({ value }) => value));
        if (ids.size > 128 || ids.size !== selector.options.length ||
            !ids.has(selector.currentValue)) {
            throw new SubscriptionAcpError('protocol');
        }
        return [selector];
    });
}

function throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new SubscriptionAcpError('cancelled');
}

function findSelector(selectors: readonly Selector[], category: Category): Selector | undefined {
    return selectors.find((selector) => selector.category === category);
}

function verifySelection(selectors: readonly Selector[], selection: Selection): void {
    if ((selection.model !== undefined && findSelector(selectors, 'model')?.currentValue !== selection.model) ||
        (selection.reasoning !== undefined &&
            findSelector(selectors, 'thought_level')?.currentValue !== selection.reasoning)) {
        throw new SubscriptionAcpError('selection-unavailable');
    }
}

/**
 * Opens a single-turn text session on an already confined provider channel.
 * Authentication checks the runner's existing login. Device login and credential custody
 * belong to the app-owned runtime. The channel is consumed and closed by prompt or close.
 */
export async function openDesktopSubscriptionAcpSession({ provider, channel, cwd }: OpenOptions) {
    let sessionId: string | undefined;
    let selectors: Selector[] = [];
    let used = false;
    let onChunk: ((text: string) => void) | undefined;
    let activeSelection: Selection | undefined;
    const peer = new AcpPeer(channel, (method, params) => {
        if (method !== 'session/update' || sessionId === undefined ||
            !isObject(params) || params.sessionId !== sessionId || !isObject(params.update)) return;
        const update = params.update;
        if (update.sessionUpdate === 'config_option_update') {
            selectors = readSelectors(update.configOptions);
            if (activeSelection && peer.isRequestPending('session/prompt')) {
                verifySelection(selectors, activeSelection);
            }
        }
        if (update.sessionUpdate === 'agent_message_chunk' && isObject(update.content) &&
            update.content.type === 'text' && typeof update.content.text === 'string') {
            if (peer.isRequestPending('session/prompt')) onChunk?.(update.content.text);
        }
    });

    async function select(category: Category, value: string | undefined) {
        if (value === undefined) return;
        const selector = findSelector(selectors, category);
        if (!selector?.options.some((option) => option.value === value)) {
            throw new SubscriptionAcpError('selection-unavailable');
        }
        if (selector.currentValue === value) return;

        await peer.request(
            'session/set_config_option', { sessionId, configId: selector.id, value },
            { onResult: (raw) => {
                const result = parse(z.object({ configOptions: z.unknown() }), raw);
                const confirmed = readSelectors(result.configOptions);
                if (findSelector(confirmed, category)?.currentValue !== value) {
                    throw new SubscriptionAcpError('selection-unavailable');
                }
                selectors = confirmed;
            } },
        );
    }

    try {
        if (!isAbsolute(cwd) || cwd.includes('\0')) throw new SubscriptionAcpError('protocol');
        const auth = authParams[provider];
        const initialization = parse(initializationSchema, await peer.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
        }));
        if (!initialization.authMethods?.some(({ id }) => id === auth.methodId)) {
            throw new SubscriptionAcpError('auth-required');
        }
        await peer.request('authenticate', auth);
        await peer.request('session/new', { cwd, mcpServers: [] }, {
            onResult: (raw) => {
                const session = parse(newSessionSchema, raw);
                sessionId = session.sessionId;
                selectors = readSelectors(session.configOptions);
            },
        });
    } catch (error) {
        await peer.shutdown();
        throw error;
    }
    const openedSession = sessionId;
    if (openedSession === undefined) {
        await peer.shutdown();
        throw new SubscriptionAcpError('protocol');
    }

    return {
        getSelectors: (): Selector[] => structuredClone(selectors),
        close: () => peer.shutdown(),
        async prompt(options: PromptOptions): Promise<{ text: string; stopReason: StopReason }> {
            if (used) throw new SubscriptionAcpError('busy');
            used = true;
            const chunks: string[] = [];
            let bytes = 0;
            const { signal, text, model, reasoning, onText } = options;
            const selection = { model, reasoning };
            try {
                throwIfCancelled(signal);
                if (!text.trim() || Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
                    throw new SubscriptionAcpError('protocol');
                }
                await select('model', model);
                throwIfCancelled(signal);
                await select('thought_level', reasoning);
                throwIfCancelled(signal);
                verifySelection(selectors, selection);
                activeSelection = selection;
                onChunk = (chunk) => {
                    if (signal?.aborted || !chunk) return;
                    bytes += Buffer.byteLength(chunk);
                    if (bytes > MAX_REPLY_BYTES) throw new SubscriptionAcpError('protocol');
                    chunks.push(chunk);
                    onText?.(chunk);
                };
                const { stopReason } = parse(promptResultSchema, await peer.request('session/prompt', {
                    sessionId: openedSession,
                    prompt: [{ type: 'text', text }],
                }, {
                    timeoutMs: TURN_TIMEOUT_MS,
                    cancellation: signal ? { signal, sessionId: openedSession } : undefined,
                }));
                if (stopReason === 'cancelled') throw new SubscriptionAcpError('cancelled');
                return { text: chunks.join(''), stopReason };
            } finally {
                onChunk = undefined;
                activeSelection = undefined;
                await peer.shutdown();
            }
        },
    };
}
