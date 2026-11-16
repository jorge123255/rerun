import { createClient } from '@libsql/client'
import { expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { desktopLocalEmbeddingIdentity, desktopLocalEmbeddingStatus, embedDesktopLocally } from './local-embedding'
import { desktopAuxiliarySchema, desktopAuxiliaryStore } from './store'

const signal = () => new AbortController().signal
const answering = (body: unknown, status = 200) => vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch

it('asks only this Mac, and reports Ollama and its embedding models', async () => {
    const fetcher = answering({ models: [{ name: 'qwen3:8b', capabilities: ['completion'] }, { name: 'nomic-embed-text:latest', capabilities: ['embedding'] }, { name: 'bge-embed-m3' }] })
    await expect(desktopLocalEmbeddingStatus(signal(), fetcher)).resolves.toEqual({ running: true, models: ['qwen3:8b', 'nomic-embed-text:latest', 'bge-embed-m3'], embeddingModels: ['nomic-embed-text:latest', 'bge-embed-m3'] })
    expect(String(vi.mocked(fetcher).mock.calls[0]![0])).toBe('http://127.0.0.1:11434/api/tags')
    await expect(desktopLocalEmbeddingStatus(signal(), vi.fn(async () => { throw new Error('refused') }) as unknown as typeof fetch)).resolves.toEqual({ running: false, models: [], embeddingModels: [] })
})

it('embeds through the local model and refuses a short or ragged answer', async () => {
    const fetcher = answering({ embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]] })
    await expect(embedDesktopLocally('nomic-embed-text', ['a', 'b'], signal(), fetcher)).resolves.toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]])
    const call = vi.mocked(fetcher).mock.calls[0]!
    expect(String(call[0])).toBe('http://127.0.0.1:11434/api/embed')
    expect(JSON.parse(String(call[1]!.body))).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] })
    await expect(embedDesktopLocally('nomic-embed-text', ['a', 'b'], signal(), answering({ embeddings: [[0.1]] }))).rejects.toThrow('incomplete')
    await expect(embedDesktopLocally('nomic-embed-text', ['a', 'b'], signal(), answering({ embeddings: [[0.1, 0.2], [0.3]] }))).rejects.toThrow('incomplete')
    await expect(embedDesktopLocally('bad model; rm', ['a'], signal(), fetcher)).rejects.toThrow('not configured')
    await expect(embedDesktopLocally('nomic-embed-text', ['a'], signal(), answering({ error: 'model not found' }, 404))).rejects.toThrow('did not accept')
})

it('files the index under the model and its size, learned once per saved setting', async () => {
    const fetcher = answering({ embeddings: [[1, 2, 3, 4]] })
    await expect(desktopLocalEmbeddingIdentity('nomic-embed-text', 'rev-1', signal(), fetcher)).resolves.toEqual({ backendId: 'ollama', model: 'nomic-embed-text', version: '1', dimensions: 4 })
    await desktopLocalEmbeddingIdentity('nomic-embed-text', 'rev-1', signal(), fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
})

it('uses OpenRouter when it has a key, else the model named for this Mac', async () => {
    const db = createClient({ url: ':memory:' })
    await db.executeMultiple(desktopAuxiliarySchema)
    const store = desktopAuxiliaryStore(db, () => Buffer.alloc(32, 7))
    expect((await store.readEmbedding()).key).toBeNull()
    await store.change({ purpose: 'local-embedding', expectedRevision: 'unconfigured', key: 'nomic-embed-text' })
    expect(await store.readEmbedding()).toMatchObject({ purpose: 'local-embedding', key: 'nomic-embed-text' })
    await store.change({ purpose: 'embedding', expectedRevision: 'unconfigured', key: 'router-key' })
    expect(await store.readEmbedding()).toMatchObject({ purpose: 'embedding', key: 'router-key' })
})

import { desktopLocalEmbeddingDownload, resetDesktopLocalEmbeddingDownload, startDesktopLocalEmbeddingDownload } from './local-embedding'

const streaming = (lines: unknown[], status = 200) => vi.fn(async () => new Response(lines.map(line => JSON.stringify(line) + '\n').join(''), { status })) as unknown as typeof fetch

it('downloads an offered model through Ollama and reports how far it has come', async () => {
    resetDesktopLocalEmbeddingDownload()
    const fetcher = streaming([{ status: 'pulling manifest' }, { status: 'pulling abc', total: 200, completed: 50 }, { status: 'pulling abc', total: 200, completed: 200 }, { status: 'pulling def', total: 10, completed: 1 }, { status: 'success' }])
    const run = startDesktopLocalEmbeddingDownload('nomic-embed-text', fetcher)
    expect(run.started).toBe(true)
    expect(desktopLocalEmbeddingDownload()).toMatchObject({ model: 'nomic-embed-text', state: 'downloading' })
    await run.finished
    expect(desktopLocalEmbeddingDownload()).toEqual({ model: 'nomic-embed-text', state: 'done', percent: 100, message: 'Downloaded' })
    const call = vi.mocked(fetcher).mock.calls[0]!
    expect(String(call[0])).toBe('http://127.0.0.1:11434/api/pull')
    expect(JSON.parse(String(call[1]!.body))).toEqual({ model: 'nomic-embed-text', stream: true })
})

it('refuses a model that is not on the offered list, and never runs two downloads at once', async () => {
    resetDesktopLocalEmbeddingDownload()
    expect(() => startDesktopLocalEmbeddingDownload('some-huge-model', streaming([]))).toThrow('cannot be downloaded')
    let release!: () => void
    const waiting = vi.fn(() => new Promise<Response>(resolve => { release = () => resolve(new Response(JSON.stringify({ status: 'success' }) + '\n')) })) as unknown as typeof fetch
    const first = startDesktopLocalEmbeddingDownload('nomic-embed-text', waiting)
    expect(startDesktopLocalEmbeddingDownload('all-minilm', streaming([])).started).toBe(false)
    release(); await first.finished
    expect(desktopLocalEmbeddingDownload()?.state).toBe('done')
})

it('says so when Ollama reports an error, stops early, or cannot be reached', async () => {
    resetDesktopLocalEmbeddingDownload()
    await startDesktopLocalEmbeddingDownload('nomic-embed-text', streaming([{ error: 'no space left on device' }])).finished
    expect(desktopLocalEmbeddingDownload()).toMatchObject({ state: 'failed', message: 'no space left on device' })
    await startDesktopLocalEmbeddingDownload('nomic-embed-text', streaming([{ status: 'pulling abc', total: 10, completed: 4 }])).finished
    expect(desktopLocalEmbeddingDownload()).toMatchObject({ state: 'failed', message: 'The download stopped before it finished.' })
    await startDesktopLocalEmbeddingDownload('nomic-embed-text', vi.fn(async () => { throw new Error('refused') }) as unknown as typeof fetch).finished
    expect(desktopLocalEmbeddingDownload()).toMatchObject({ state: 'failed', message: 'Ollama could not be reached. Open Ollama and try again.' })
})
