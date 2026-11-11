import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDesktopSubscriptionAcpSession } from './session.js';

interface Request {
    id?: number;
    method: string;
    params: Record<string, unknown>;
}

const modelOptions = [
    { value: 'fast', name: 'Fast' },
    { value: 'precise', name: 'Precise' },
];
const reasoningOptions = [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
];

function config(model = 'fast', reasoning = 'low') {
    return [
        { type: 'select', category: 'model', id: 'model-choice', currentValue: model,
            options: [{ group: 'default', name: 'Available', options: modelOptions }] },
        { type: 'select', category: 'thought_level', id: 'effort', currentValue: reasoning,
            options: reasoningOptions },
        { type: 'select', category: 'mode', id: 'approval-mode', currentValue: 'ask', options: [] },
    ];
}

function chunk(text: string, sessionId = 'ours') {
    return {
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    };
}

function configUpdate(configOptions: ReturnType<typeof config>) {
    return {
        method: 'session/update',
        params: { sessionId: 'ours', update: { sessionUpdate: 'config_option_update', configOptions } },
    };
}

function record(message: object) {
    return JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
}

function fakeRunner(
    authMethods = ['login', 'cached_token'],
    handle?: (request: Request, runner: ReturnType<typeof wire>) => boolean,
) {
    const runner = wire();
    runner.channel.output.on('data', (data: Buffer) => {
        const request: Request = JSON.parse(data.toString());
        runner.requests.push(request);
        if (handle?.(request, runner) || !request.method) return;
        switch (request.method) {
            case 'initialize':
                runner.reply(request, { protocolVersion: 1, authMethods: authMethods.map((id) => ({ id })) });
                break;
            case 'authenticate':
                runner.reply(request, {});
                break;
            case 'session/new':
                runner.reply(request, { sessionId: 'ours', configOptions: config() });
                break;
            case 'session/prompt':
                runner.send(chunk('Hello'));
                runner.reply(request, { stopReason: 'end_turn' });
                break;
        }
    });
    return runner;
}

function wire() {
    const channel = { input: new PassThrough(), output: new PassThrough() };
    const requests: Request[] = [];
    const send = (message: object) => channel.input.write(record(message));
    return { channel, requests, send, reply: (request: Request, result: unknown) => send({ id: request.id, result }) };
}

function open(runner: ReturnType<typeof wire>, provider: 'grok-build' | 'kimi-code' = 'kimi-code') {
    return openDesktopSubscriptionAcpSession({ channel: runner.channel, cwd: '/disposable-qa', provider });
}

afterEach(() => vi.useRealTimers());

describe('desktop subscription ACP sessions', () => {
    it.each([
        ['grok-build', { methodId: 'cached_token', _meta: { headless: true } }],
        ['kimi-code', { methodId: 'login' }],
    ] as const)('uses the documented cached login for %s and opens a text-only session', async (provider, auth) => {
        const runner = fakeRunner();
        const session = await open(runner, provider);
        expect(runner.requests.map(({ method, params }) => ({ method, params }))).toEqual([
            { method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
            { method: 'authenticate', params: auth },
            { method: 'session/new', params: { cwd: '/disposable-qa', mcpServers: [] } },
        ]);
        expect(session.getSelectors().map(({ id }) => id)).toEqual(['model-choice', 'effort']);
        await expect(session.prompt({ text: 'Say hello' })).resolves.toEqual({ text: 'Hello', stopReason: 'end_turn' });
        await expect(session.prompt({ text: 'Do not reuse the session' })).rejects.toMatchObject({ code: 'busy' });
        expect(runner.channel.input.destroyed && runner.channel.output.destroyed).toBe(true);
    });

    it('never switches to API-key authentication', async () => {
        const runner = fakeRunner(['xai.api_key']);
        await expect(open(runner, 'grok-build')).rejects.toMatchObject({ code: 'auth-required' });
        expect(runner.requests.map(({ method }) => method)).toEqual(['initialize']);
        expect(runner.channel.output.destroyed).toBe(true);
    });

    it('redacts provider errors and refuses to create a session without a login', async () => {
        const runner = fakeRunner(['login'], (request, { send }) => {
            if (request.method !== 'authenticate') return false;
            send({ id: request.id, error: { code: -32000, message: 'fixture-secret', data: 'fixture-private-path' } });
            return true;
        });
        await expect(open(runner)).rejects.toMatchObject({
            code: 'auth-required',
            message: 'Sign in to the subscription provider first.',
        });
        expect(runner.requests.some(({ method }) => method === 'session/new')).toBe(false);
    });

    it('confirms the advertised model and reasoning before sending the turn', async () => {
        const runner = fakeRunner(['login'], (request, { reply }) => {
            if (request.method !== 'session/set_config_option') return false;
            const reasoning = request.params.configId === 'effort' ? 'high' : 'low';
            reply(request, { configOptions: config('precise', reasoning) });
            return true;
        });
        const session = await open(runner);
        expect(session.getSelectors()[0].options).toEqual(modelOptions);
        await expect(session.prompt({ text: 'Example', model: 'precise', reasoning: 'high' })).resolves.toEqual({
            text: 'Hello', stopReason: 'end_turn',
        });
        expect(runner.requests.slice(3).map(({ method, params }) => ({ method, params }))).toEqual([
            { method: 'session/set_config_option', params: { sessionId: 'ours', configId: 'model-choice', value: 'precise' } },
            { method: 'session/set_config_option', params: { sessionId: 'ours', configId: 'effort', value: 'high' } },
            { method: 'session/prompt', params: { sessionId: 'ours', prompt: [{ type: 'text', text: 'Example' }] } },
        ]);
    });

    it.each(['unadvertised', 'unconfirmed', 'changed by a newer update'])('refuses a %s model before prompt', async (failure) => {
        const runner = fakeRunner(['login'], (request, { channel, reply }) => {
            if (request.method !== 'session/set_config_option') return false;
            if (failure === 'changed by a newer update') {
                channel.input.write(record({ id: request.id, result: { configOptions: config('precise') } }) +
                    record(configUpdate(config())));
            } else {
                reply(request, { configOptions: config() });
            }
            return true;
        });
        const session = await open(runner);
        const model = failure === 'unadvertised' ? 'other' : 'precise';
        await expect(session.prompt({ text: 'Example', model })).rejects.toMatchObject({ code: 'selection-unavailable' });
        expect(runner.requests.some(({ method }) => method === 'session/prompt')).toBe(false);
    });

    it('applies a confirmed selection after an older update received in the same read', async () => {
        const runner = fakeRunner(['login'], (request, { channel }) => {
            if (request.method !== 'session/set_config_option') return false;
            channel.input.write(record(configUpdate(config())) +
                record({ id: request.id, result: { configOptions: config('precise') } }));
            return true;
        });
        const session = await open(runner);
        await expect(session.prompt({ text: 'Example', model: 'precise' })).resolves.toEqual({
            text: 'Hello', stopReason: 'end_turn',
        });
    });

    it('rejects a mid-turn fallback away from the selected model', async () => {
        const runner = fakeRunner(['login'], (request, { send }) => {
            if (request.method !== 'session/prompt') return false;
            send(configUpdate(config('precise')));
            return true;
        });
        const session = await open(runner);
        await expect(session.prompt({ text: 'Example', model: 'fast' })).rejects.toMatchObject({ code: 'selection-unavailable' });
    });

    it('streams only pre-terminal text from the active session and handles fragmented UTF-8', async () => {
        const runner = fakeRunner(['login'], (request, { channel }) => {
            if (request.method !== 'session/prompt') return false;
            const text = Buffer.from(record(chunk('café')));
            const split = text.indexOf(Buffer.from('é')) + 1;
            channel.input.write(text.subarray(0, split));
            channel.input.write(text.subarray(split));
            channel.input.write(record(chunk('foreign', 'another-session')) +
                record({ id: request.id, result: { stopReason: 'max_tokens' } }) +
                record(chunk('late')));
            return true;
        });
        const onText = vi.fn();
        const session = await open(runner);
        await expect(session.prompt({ text: 'Example', onText })).resolves.toEqual({ text: 'café', stopReason: 'max_tokens' });
        expect(onText.mock.calls).toEqual([['café']]);
    });

    it('cancels permission requests and has no client filesystem or terminal methods', async () => {
        const runner = fakeRunner(['login'], (request, { send }) => {
            if (request.method !== 'session/prompt') return false;
            send({ id: 'perm', method: 'session/request_permission', params: { sessionId: 'ours' } });
            send({ id: 'fs', method: 'fs/read_text_file', params: {} });
            send({ id: 'term', method: 'terminal/create', params: {} });
            send({ id: request.id, result: { stopReason: 'refusal' } });
            return true;
        });
        const session = await open(runner);
        await expect(session.prompt({ text: 'Example' })).resolves.toEqual({ text: '', stopReason: 'refusal' });
        expect(runner.requests.slice(4)).toEqual([
            { jsonrpc: '2.0', id: 'perm', result: { outcome: { outcome: 'cancelled' } } },
            { jsonrpc: '2.0', id: 'fs', error: { code: -32601, message: 'Method not available' } },
            { jsonrpc: '2.0', id: 'term', error: { code: -32601, message: 'Method not available' } },
        ]);
    });

    it('stops the active turn, suppresses late text, and closes after acknowledgement', async () => {
        const started = Promise.withResolvers<void>();
        let prompt: Request | undefined;
        const runner = fakeRunner(['login'], (request, { send, reply }) => {
            if (request.method === 'session/prompt') {
                prompt = request;
                send(chunk('before'));
                started.resolve();
                return true;
            }
            if (request.method !== 'session/cancel' || !prompt) return false;
            send(chunk('after'));
            reply(prompt, { stopReason: 'cancelled' });
            return true;
        });
        const abort = new AbortController();
        const onText = vi.fn();
        const session = await open(runner);
        const result = session.prompt({ text: 'Example', onText, signal: abort.signal });
        const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
        await started.promise;
        abort.abort();
        await rejected;
        expect(runner.requests.at(-1)).toEqual({
            jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'ours' },
        });
        expect(onText.mock.calls).toEqual([['before']]);
        expect(runner.channel.output.destroyed).toBe(true);
    });

    it('bounds the wait for a cancelled runner that does not acknowledge Stop', async () => {
        vi.useFakeTimers();
        const started = Promise.withResolvers<void>();
        const runner = fakeRunner(['login'], (request) => {
            if (request.method !== 'session/prompt') return false;
            started.resolve();
            return true;
        });
        const abort = new AbortController();
        const session = await open(runner);
        const result = session.prompt({ text: 'Example', signal: abort.signal });
        const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
        await started.promise;
        abort.abort();
        expect(runner.channel.output.destroyed).toBe(false);
        await vi.advanceTimersByTimeAsync(2000);
        await rejected;
        expect(runner.channel.output.destroyed).toBe(true);
    });

    it('keeps a completed turn when Stop arrives after the terminal response', async () => {
        const abort = new AbortController();
        const runner = fakeRunner(['login'], (request, { reply, send }) => {
            if (request.method !== 'session/prompt') return false;
            send(chunk('complete'));
            reply(request, { stopReason: 'end_turn' });
            abort.abort();
            return true;
        });
        const session = await open(runner);
        await expect(session.prompt({ text: 'Example', signal: abort.signal })).resolves.toEqual({
            text: 'complete', stopReason: 'end_turn',
        });
        expect(runner.requests.some(({ method }) => method === 'session/cancel')).toBe(false);
    });

    it.each(['oversized', 'malformed', 'out-of-sequence'])('closes an %s wire response', async (kind) => {
        const runner = fakeRunner(['login'], (request, { channel, send }) => {
            if (request.method !== 'initialize') return false;
            if (kind === 'oversized') channel.input.write(Buffer.alloc(1024 * 1024 + 1, 32));
            if (kind === 'malformed') channel.input.write('bad json\n');
            if (kind === 'out-of-sequence') send({ id: 99, result: {} });
            return true;
        });
        await expect(open(runner)).rejects.toMatchObject({ code: 'protocol' });
        expect(runner.channel.output.destroyed).toBe(true);
    });

    it('rejects an incompatible protocol version before authentication', async () => {
        const runner = fakeRunner(['login'], (request, { reply }) => {
            if (request.method !== 'initialize') return false;
            reply(request, { protocolVersion: 2, authMethods: [{ id: 'login' }] });
            return true;
        });
        await expect(open(runner)).rejects.toMatchObject({ code: 'protocol' });
        expect(runner.requests.map(({ method }) => method)).toEqual(['initialize']);
    });
});
