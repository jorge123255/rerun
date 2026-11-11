import type { Readable, Writable } from 'node:stream';

const MAX_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const CANCEL_TIMEOUT_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

type Failure = 'closed' | 'protocol' | 'rejected' | 'timeout' | 'cancelled'
    | 'auth-required' | 'selection-unavailable' | 'busy' | 'shutdown-unconfirmed';

const messages: Record<Failure, string> = {
    closed: 'The subscription provider connection closed.',
    protocol: 'The subscription provider sent an invalid response.',
    rejected: 'The subscription provider rejected the request.',
    timeout: 'The subscription provider did not respond in time.',
    cancelled: 'The subscription provider turn was cancelled.',
    'auth-required': 'Sign in to the subscription provider first.',
    'selection-unavailable': 'The selected subscription model or reasoning level is unavailable.',
    busy: 'The subscription provider connection is already in use.',
    'shutdown-unconfirmed': 'The subscription provider did not stop cleanly.',
};

export class SubscriptionAcpError extends Error {
    constructor(readonly code: Failure) {
        super(messages[code]);
        this.name = 'SubscriptionAcpError';
    }
}

export interface AcpChannel {
    readonly input: Readable;
    readonly output: Writable;
    // The runtime owns termination and must confirm its runner has stopped.
    dispose(): Promise<void>;
}

type RpcObject = Record<string, unknown>;

export function isObject(value: unknown): value is RpcObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RequestOptions {
    timeoutMs?: number;
    cancellation?: { signal: AbortSignal; sessionId?: string };
    onResult?: (result: unknown) => void;
}

interface Pending {
    id: number;
    method: string;
    onResult?: (result: unknown) => void;
    finish: (error: SubscriptionAcpError | null, result?: unknown) => void;
}

/** Owns one private stdio pair supplied by the caller. Does not spawn processes. */
export class AcpPeer {
    private readonly frame = Buffer.allocUnsafe(MAX_FRAME_BYTES);
    private readonly decoder = new TextDecoder('utf-8', { fatal: true });
    private offset = 0;
    private nextId = 1;
    private pending: Pending | undefined;
    private failure: SubscriptionAcpError | undefined;
    private disposal: Promise<boolean> | undefined;

    constructor(
        private readonly channel: AcpChannel,
        private readonly onNotification: (method: string, params: unknown) => void,
    ) {
        const onClose = () => this.close();
        channel.input.on('error', onClose);
        channel.output.on('error', onClose);
        channel.input.once('end', onClose);
        channel.input.once('close', onClose);
        channel.output.once('close', onClose);
        channel.input.on('data', this.onData);
        if (channel.input.destroyed || channel.output.destroyed) this.close();
    }

    request(method: string, params: RpcObject, options: RequestOptions = {}): Promise<unknown> {
        if (this.failure) return Promise.reject(this.failure);
        if (this.pending) return Promise.reject(new SubscriptionAcpError('busy'));

        const { cancellation } = options;
        if (cancellation?.signal.aborted) {
            return Promise.reject(new SubscriptionAcpError('cancelled'));
        }

        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            let cancelled = false;
            let timer = setTimeout(() => this.close('timeout'), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
            const abort = () => {
                if (cancellation?.sessionId === undefined) {
                    this.close('cancelled');
                    return;
                }
                cancelled = true;
                clearTimeout(timer);
                timer = setTimeout(() => this.close('cancelled'), CANCEL_TIMEOUT_MS);
                this.send({ method: 'session/cancel', params: { sessionId: cancellation.sessionId } });
            };
            this.pending = {
                id,
                method,
                onResult: options.onResult,
                finish: (error, result) => {
                    this.pending = undefined;
                    clearTimeout(timer);
                    cancellation?.signal.removeEventListener('abort', abort);
                    if (cancelled) {
                        reject(new SubscriptionAcpError('cancelled'));
                        this.close('cancelled');
                    } else if (error) {
                        reject(error);
                    } else {
                        resolve(result);
                    }
                },
            };
            cancellation?.signal.addEventListener('abort', abort, { once: true });
            this.send({ id, method, params });
        });
    }

    isRequestPending(method: string): boolean {
        return this.pending?.method === method;
    }

    close(code: Failure = 'closed'): void {
        if (this.failure) return;
        this.failure = new SubscriptionAcpError(code);
        this.pending?.finish(this.failure);
        this.channel.input.off('data', this.onData);
        this.channel.input.destroy();
        this.channel.output.destroy();
        this.disposal = new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS);
            const finish = (stopped: boolean) => {
                clearTimeout(timer);
                resolve(stopped);
            };
            void Promise.resolve().then(() => this.channel.dispose()).then(() => finish(true), () => finish(false));
        });
    }

    async shutdown(): Promise<void> {
        this.close();
        if (!await this.disposal) throw new SubscriptionAcpError('shutdown-unconfirmed');
    }

    private send(message: RpcObject): void {
        if (this.failure) return;
        try {
            const record = JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
            if (Buffer.byteLength(record) > MAX_FRAME_BYTES ||
                this.channel.output.writableLength > MAX_FRAME_BYTES) {
                this.close('protocol');
                return;
            }
            this.channel.output.write(record);
        } catch {
            this.close();
        }
    }

    private readonly onData = (chunk: Buffer | string): void => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        try {
            let start = 0;
            while (start < bytes.length && !this.failure) {
                const newline = bytes.indexOf(10, start);
                const end = newline === -1 ? bytes.length : newline;
                const length = end - start;
                if (this.offset + length > MAX_FRAME_BYTES) {
                    this.close('protocol');
                    return;
                }
                bytes.copy(this.frame, this.offset, start, end);
                this.offset += length;
                if (newline === -1) return;

                const record: unknown = JSON.parse(this.decoder.decode(this.frame.subarray(0, this.offset)));
                this.offset = 0;
                this.receive(record);
                start = newline + 1;
            }
        } catch (error) {
            this.close(error instanceof SubscriptionAcpError ? error.code : 'protocol');
        }
    };

    private receive(record: unknown): void {
        if (!isObject(record) || record.jsonrpc !== '2.0') {
            this.close('protocol');
            return;
        }
        if (typeof record.method === 'string') {
            if (!Object.hasOwn(record, 'id')) {
                this.onNotification(record.method, record.params);
                return;
            }
            if (typeof record.id !== 'string' && !Number.isSafeInteger(record.id)) {
                this.close('protocol');
                return;
            }
            if (record.method === 'session/request_permission') {
                this.send({ id: record.id, result: { outcome: { outcome: 'cancelled' } } });
            } else {
                this.send({ id: record.id, error: { code: -32601, message: 'Method not available' } });
            }
            return;
        }

        const pending = this.pending;
        const hasResult = Object.hasOwn(record, 'result');
        const hasError = Object.hasOwn(record, 'error');
        if (!pending || record.id !== pending.id || hasResult === hasError) {
            this.close('protocol');
            return;
        }
        if (hasError) {
            if (!isObject(record.error) || !Number.isSafeInteger(record.error.code)) {
                this.close('protocol');
                return;
            }
            // Provider error text and data can contain secrets.
            const code = record.error.code === -32000 ? 'auth-required'
                : record.error.code === -32800 ? 'cancelled' : 'rejected';
            pending.finish(new SubscriptionAcpError(code));
            return;
        }
        pending.onResult?.(record.result);
        pending.finish(null, record.result);
    }
}
