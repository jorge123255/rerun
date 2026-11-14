import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AcpPeer, isObject, SubscriptionAcpError, type AcpChannel } from './peer.js';

const TURN_TIMEOUT_MS = 5 * 60_000;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_REPLY_BYTES = 1024 * 1024;

const authParams = {
    'grok-build': { methodId: 'cached_token', _meta: { headless: true } },
    'kimi-code': { methodId: 'login' },
    // Devin reads the sign-in saved in its private folders; its only auth method opens a browser.
    devin: null,
} as const;

const idSchema = z.string().min(1).max(512);
const optionSchema = z.object({ value: idSchema, name: z.string().min(1).max(512) });
// Devin lists one model per effort: well over a hundred entries.
const optionsSchema = z.union([
    z.array(optionSchema).max(512),
    z.array(z.object({ options: z.array(optionSchema).max(512) })).max(128)
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
    signal?: AbortSignal;
    beforePrompt?: () => void;
    /** Receives the provider's own plan usage answer, read once a reply is complete. */
    onPlanUsage?: (usage: unknown) => void;
}

function devinModelId(model: string, effort: string | undefined): string {
    const split = model.match(/^(.+?)(-fast|-lightning)?$/);
    return effort && split ? `${split[1]}-${effort}${split[2] ?? ''}` : model;
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const result = schema.safeParse(raw);
    if (!result.success) throw new SubscriptionAcpError('protocol');
    return result.data;
}

function readSelectors(raw: unknown): Selector[] {
    const options = parse(z.array(z.unknown()).max(64).nullish(), raw) ?? [];
    const selectors = options.flatMap((option) => {
        if (!isObject(option) || option.type !== 'select' ||
            (option.category !== 'model' && option.category !== 'thought_level')) return [];
        const selector = parse(selectorSchema, option);
        const ids = new Set(selector.options.map(({ value }) => value));
        if (ids.size > 512 || ids.size !== selector.options.length ||
            !ids.has(selector.currentValue)) {
            throw new SubscriptionAcpError('protocol');
        }
        return [selector];
    });
    if (new Set(selectors.map(selector => selector.category)).size !== selectors.length) {
        throw new SubscriptionAcpError('protocol');
    }
    return selectors;
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
// Grok reports its plan usage through an ACP extension of its own. The others have none.
const planUsageMethod: Partial<Record<keyof typeof authParams, string>> = { 'grok-build': '_x.ai/billing' };
const PLAN_USAGE_TIMEOUT_MS = 8000;

export async function openDesktopSubscriptionAcpSession({ provider, channel, cwd, signal: openSignal, beforePrompt, onPlanUsage }: OpenOptions) {
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

    async function select(category: Category, value: string | undefined, signal?: AbortSignal) {
        throwIfCancelled(signal);
        if (value === undefined) return;
        const selector = findSelector(selectors, category);
        if (!selector?.options.some((option) => option.value === value)) {
            throw new SubscriptionAcpError('selection-unavailable');
        }
        if (selector.currentValue === value) return;

        await peer.request(
            'session/set_config_option', { sessionId, configId: selector.id, value },
            { cancellation: signal ? { signal } : undefined, onResult: (raw) => {
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
        const cancellation = openSignal ? { signal: openSignal } : undefined;
        const initialization = parse(initializationSchema, await peer.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
        }, { cancellation }));
        if (auth) {
            if (!initialization.authMethods?.some(({ id }) => id === auth.methodId)) {
                throw new SubscriptionAcpError('auth-required');
            }
            await peer.request('authenticate', auth, { cancellation });
        }
        let modes: unknown;
        await peer.request('session/new', { cwd, mcpServers: [] }, {
            cancellation,
            onResult: (raw) => {
                const session = parse(newSessionSchema, raw);
                sessionId = session.sessionId;
                selectors = readSelectors(session.configOptions);
                modes = session.configOptions;
            },
        });
        if (provider === 'devin') {
            // Ask mode answers in text and runs none of Devin's own tools. A session that cannot be
            // put in it is not used.
            const mode = (Array.isArray(modes) ? modes : []).find((option) => isObject(option) && option.category === 'mode');
            if (!isObject(mode) || typeof mode.id !== 'string') throw new SubscriptionAcpError('protocol');
            await peer.request('session/set_config_option', { sessionId, configId: mode.id, value: 'ask' }, {
                cancellation,
                onResult: (raw) => {
                    const result = parse(z.object({ configOptions: z.array(z.unknown()) }), raw);
                    const confirmed = result.configOptions.find((option) => isObject(option) && option.category === 'mode');
                    if (!isObject(confirmed) || confirmed.currentValue !== 'ask') throw new SubscriptionAcpError('protocol');
                    selectors = readSelectors(result.configOptions);
                },
            });
        }
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
        async selectModel(model: string, signal?: AbortSignal): Promise<Selector[]> {
            if (used) throw new SubscriptionAcpError('busy');
            await select('model', model, signal);
            verifySelection(selectors, { model });
            return structuredClone(selectors);
        },
        close: () => peer.shutdown(),
        /** The provider's plan usage, or null when it has no such call. Sends no prompt. */
        async readPlanUsage(signal?: AbortSignal): Promise<unknown> {
            const method = planUsageMethod[provider];
            if (!method) return null;
            return peer.request(method, {}, { timeoutMs: PLAN_USAGE_TIMEOUT_MS, cancellation: signal ? { signal } : undefined });
        },
        async prompt(options: PromptOptions): Promise<{ text: string; stopReason: StopReason }> {
            if (used) throw new SubscriptionAcpError('busy');
            used = true;
            const chunks: string[] = [];
            let bytes = 0;
            const { signal, text, onText } = options;
            // Devin has no effort selector: the effort is part of the model's id.
            const model = provider === 'devin' && options.model !== undefined ? devinModelId(options.model, options.reasoning) : options.model;
            const reasoning = provider === 'devin' ? undefined : options.reasoning;
            const selection = { model, reasoning };
            try {
                throwIfCancelled(signal);
                if (!text.trim() || Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
                    throw new SubscriptionAcpError('protocol');
                }
                await select('model', model, signal);
                await select('thought_level', reasoning, signal);
                throwIfCancelled(signal);
                verifySelection(selectors, selection);
                beforePrompt?.();
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
                const usageMethod = onPlanUsage && planUsageMethod[provider];
                // The reply is complete; a usage read that fails costs the gauge, never the reply.
                if (usageMethod) await peer.request(usageMethod, {}, { timeoutMs: PLAN_USAGE_TIMEOUT_MS }).then(onPlanUsage, () => {});
                return { text: chunks.join(''), stopReason };
            } finally {
                onChunk = undefined;
                activeSelection = undefined;
                await peer.shutdown();
            }
        },
    };
}
