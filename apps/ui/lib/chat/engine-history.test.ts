import type { EngineMessage } from '@rerun/contracts'
import { describe, expect, it } from 'vitest'
import { RERUN_PUBLIC_DOCS_CORPUS, workspaceAttachmentPart, desktopCoworkerMentionContextParts } from '@rerun/contracts'
import { buildAttachmentsRef } from '@/lib/chat/attachments-marker'
import { buildInstallMessage } from '@/lib/chat/install-marker'
import { MAX_TOOL_OUTPUT_CHARS, type HistoryMessage, publicDesktopHistory, toApiMessages, transformEngineMessages } from '@/lib/chat/engine-history'
import { PEAK_COUNT } from '@/lib/voice/peaks'

function user(text: string): HistoryMessage {
    return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] }
}

function toolCall(toolName: string, output: unknown): HistoryMessage {
    return { id: 'a1', role: 'assistant', parts: [{ type: `tool-${toolName}`, toolCallId: 'c1', toolName, state: 'output-available', input: {}, output }] }
}

describe('saved Foreman documentation presentation', () => {
    const result = {
        status: 'ok', documentation: RERUN_PUBLIC_DOCS_CORPUS.documentation,
        passages: [{ title: 'Automations', url: 'https://docs.rerun.build/agents/automations#webhook-triggers', text: 'Triggers can start a coworker.' }],
        source: { corpusId: RERUN_PUBLIC_DOCS_CORPUS.id, sourceUrl: RERUN_PUBLIC_DOCS_CORPUS.exportUrl, cacheState: 'fresh', fetchedAt: '2026-11-06T00:00:00.000Z', ageMs: 1000, sha256: 'a'.repeat(64), byteLength: 100, version: 'v1' },
    }
    const saved = (output: unknown) => [{
        id: 'docs-call', sessionId: 'foreman-session', role: 'assistant' as const,
        contentJson: JSON.stringify([{ type: 'tool-call', toolName: 'search_docs', toolCallId: 'docs-1', input: { query: 'webhook triggers', binding: { privateRun: 'not-public' } } }]),
        toolCallsJson: null, createdAt: '2026-11-06T00:00:00.000Z',
    }, {
        id: 'docs-result', sessionId: 'foreman-session', role: 'tool' as const,
        contentJson: JSON.stringify([{ type: 'tool-result', toolName: 'search_docs', toolCallId: 'docs-1', output }]),
        toolCallsJson: null, createdAt: '2026-11-06T00:00:01.000Z',
    }]

    it.each(['direct', 'json-wrapper', 'text-wrapper'] as const)('retains validated citations and source metadata from actual saved %s results', shape => {
        const output = shape === 'direct' ? result : { type: shape === 'json-wrapper' ? 'json' : 'text', value: shape === 'json-wrapper' ? result : JSON.stringify(result) }
        const rows = saved(output)
        const original = rows.map(row => row.contentJson)
        const [message] = publicDesktopHistory(transformEngineMessages(rows))
        expect(message.parts[0]).toEqual({
            type: 'tool-search_docs', toolName: 'search_docs', toolCallId: 'docs-1', state: 'output-available', desktopPreview: true,
            input: { preview: 'webhook triggers' }, output: JSON.stringify(result),
        })
        expect(JSON.stringify(message)).not.toContain('not-public')
        expect(rows.map(row => row.contentJson)).toEqual(original)
    })

    it.each([
        { ...result, passages: [{ ...result.passages[0], url: 'https://example.com/private' }] },
        { ...result, source: { ...result.source, corpusId: 'other-corpus' } },
        { ...result, source: { ...result.source, sourceUrl: 'https://docs.rerun.build/private.txt' } },
        { ...result, binding: { secret: 'not-public' } },
        JSON.stringify({ ...result, authorization: 'Bearer not-public' }),
    ])('does not expose malformed or noncanonical documentation results', output => {
        const [message] = publicDesktopHistory(transformEngineMessages(saved(output)))
        expect(message.parts[0]).toEqual({ type: 'tool-search_docs', toolName: 'search_docs', toolCallId: 'docs-1', state: 'output-available', desktopPreview: true, input: { preview: 'webhook triggers' } })
        expect(JSON.stringify(message)).not.toContain('not-public')
        expect(JSON.stringify(message)).not.toContain('example.com')
    })
})

describe('toApiMessages', () => {
    it('keeps a plain user message as is', () => {
        expect(toApiMessages([user('Hello')])).toEqual([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }])
    })

    it('lifts the attachments marker into metadata', () => {
        const [message] = toApiMessages([user(`Look at these\n\n${buildAttachmentsRef(['chat-uploads/mtr4k52x-lBg1lF-hero.png', 'chat-uploads/report.pdf'])}`)])
        expect(message.parts).toEqual([{ type: 'text', text: 'Look at these' }])
        expect(message.metadata?.attachments).toEqual([
            { name: 'hero.png', path: 'chat-uploads/mtr4k52x-lBg1lF-hero.png', mediaType: 'image/png' },
            { name: 'report.pdf', path: 'chat-uploads/report.pdf', mediaType: 'application/pdf' },
        ])
    })

    it('sends files sent without a word with no text part', () => {
        const [message] = toApiMessages([user(buildAttachmentsRef(['chat-uploads/a.bin']))])
        expect(message.parts).toEqual([])
        expect(message.metadata?.attachments?.[0].mediaType).toBe('application/octet-stream')
    })

    it('lifts the voice marker into metadata', () => {
        const [message] = toApiMessages([user('Call them back\n\n<voice src="chat-uploads/v.m4a" ms="4200" peaks="">')])
        expect(message.parts).toEqual([])
        expect(message.metadata?.voice).toEqual({ transcript: 'Call them back', src: 'chat-uploads/v.m4a', durationMs: 4200, peaks: '' })
    })

    it('lifts a voice message and the files sent with it together', () => {
        const [message] = toApiMessages([user(`Read this brief\n\n<voice src="chat-uploads/v.m4a" ms="4200" peaks="">\n\n${buildAttachmentsRef(['chat-uploads/brief.pdf'])}`)])
        expect(message.parts).toEqual([])
        expect(message.metadata?.voice).toEqual({ transcript: 'Read this brief', src: 'chat-uploads/v.m4a', durationMs: 4200, peaks: '' })
        expect(message.metadata?.attachments).toEqual([{ name: 'brief.pdf', path: 'chat-uploads/brief.pdf', mediaType: 'application/pdf' }])
    })

    it('hands the app the bare guide of an install, and who it installs', () => {
        const [message] = toApiMessages([user(buildInstallMessage('## Connect Gmail', 'Closer'))])
        expect(message).toEqual({ id: 'u1', role: 'user', parts: [{ type: 'text', text: '## Connect Gmail' }], metadata: { install: { agentName: 'Closer' } } })
    })

    it('hands the app the bare prompt of a scheduled run, and which routine fired it', () => {
        const [message] = toApiMessages([user('<scheduled_run schedule="daily-digest" name="Daily digest">\nSend the digest.\n</scheduled_run>')])
        expect(message).toEqual({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Send the digest.' }], metadata: { scheduledRun: { slug: 'daily-digest', name: 'Daily digest' } } })
    })

    it('hands the waveform over unchanged', () => {
        const peaks = 'a'.repeat(PEAK_COUNT / 2) + 'z'.repeat(PEAK_COUNT / 2)
        const [message] = toApiMessages([user(`Hi\n\n<voice src="chat-uploads/v.m4a" ms="4200" peaks="${peaks}">`)])
        expect(message.metadata?.voice?.peaks).toBe(peaks)
    })

    it('hands the app when each message was written', () => {
        const createdAt = '2026-10-26T09:41:00.000Z'
        const [question, answer] = toApiMessages([
            { ...user('Hello'), metadata: { createdAt, authorId: 'me' } },
            { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }], metadata: { createdAt } },
        ])
        expect(question.metadata).toEqual({ createdAt, authorId: 'me' })
        expect(answer.metadata).toEqual({ createdAt })
    })

    it('dates a scheduled run as well as its routine', () => {
        const createdAt = '2026-10-26T09:41:00.000Z'
        const [message] = toApiMessages([{ ...user('<scheduled_run schedule="daily-digest" name="Daily digest">\nSend the digest.\n</scheduled_run>'), metadata: { createdAt } }])
        expect(message.metadata).toEqual({ createdAt, scheduledRun: { slug: 'daily-digest', name: 'Daily digest' } })
    })

    it('replaces an oversized tool output with a preview', () => {
        const [message] = toApiMessages([toolCall('web_fetch', 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1))])
        expect(message.parts[0]).toMatchObject({ output: { truncated: true, preview: 'x'.repeat(MAX_TOOL_OUTPUT_CHARS) } })
    })

    it('keeps what a paid call billed when it trims its output, so the spend receipt still adds up', () => {
        const output = { status: 'found', billedMicros: 4_500, message: 'Found.', result: 'r'.repeat(MAX_TOOL_OUTPUT_CHARS) }
        const [message] = toApiMessages([toolCall('mcp__rerun__paid_data', output)])
        expect(message.parts[0]).toMatchObject({ output: { status: 'found', billedMicros: 4_500, truncated: true } })
    })

    it('keeps a small tool output whole', () => {
        const [message] = toApiMessages([toolCall('web_fetch', { ok: true })])
        expect(message.parts[0]).toMatchObject({ output: { ok: true } })
    })

    it('never trims a card, whatever its size', () => {
        const rows = 'r'.repeat(MAX_TOOL_OUTPUT_CHARS * 2)
        const [message] = toApiMessages([toolCall('mcp__rerun__card_table', { rows })])
        expect(message.parts[0]).toMatchObject({ output: { rows } })
    })
})

describe('a card and the message written after it', () => {
    const at = (n: number) => `2026-10-09T14:02:${String(n).padStart(2, '0')}Z`
    const assistant = (id: string, content: unknown[], n: number) => ({ id, sessionId: 's1', role: 'assistant' as const, contentJson: JSON.stringify(content), toolCallsJson: null, createdAt: at(n) })
    const toolRow = (id: string, toolCallId: string, n: number) => ({ id, sessionId: 's1', role: 'tool' as const, contentJson: JSON.stringify([{ type: 'tool-result', toolCallId, toolName: 'ask_user', output: { status: 'delivered' } }]), toolCallsJson: null, createdAt: at(n) })
    const askUser = (toolCallId: string) => ({ type: 'tool-call', toolCallId, toolName: 'ask_user', input: { questions: [{ question: 'Which product?' }] } })

    it('restores only marked Codex summaries for desktop, without raw or encrypted provider fields', () => {
        const rows = [assistant('a1', [
            { type: 'reasoning', text: 'Raw' },
            { type: 'reasoning', text: 'Legacy mixed content', providerOptions: { 'codex-app-server': { isSummary: true } } },
            { type: 'reasoning', text: 'Comparing options.', providerOptions: { 'codex-app-server': { isPublicSummary: true, encrypted: 'Opaque bytes' } } },
            { type: 'text', text: 'Reply' },
        ], 1)]
        expect(transformEngineMessages(rows, { desktopSummaries: true })[0].parts).toEqual([
            { type: 'reasoning', text: 'Comparing options.', providerMetadata: { 'codex-app-server': { isPublicSummary: true } } },
            { type: 'text', text: 'Reply' },
        ])
        expect(transformEngineMessages(rows)[0].parts).toEqual([{ type: 'text', text: 'Reply' }])
        const legacyObject = { ...rows[0], contentJson: JSON.stringify({ type: 'reasoning', text: 'Hidden object' }) }
        expect(transformEngineMessages([legacyObject], { desktopSummaries: true })).toEqual([])
    })

    it('restores only validated source metadata from its own assistant row', () => {
        const web = { type: 'source-url', sourceId: 'url', url: 'https://example.org/brief' }
        const doc = { type: 'source-document', sourceId: 'doc', mediaType: 'application/pdf', filename: 'brief.pdf' }
        const ordinary = assistant('plain', [{ type: 'text', text: '[link](https://example.org/ordinary)' }], 1)
        const cited = { ...assistant('cited', [{ type: 'text', text: 'Brief.' }], 2), sourcesJson: JSON.stringify([
            { ...web, providerMetadata: { privateValue: 'hidden' } }, web, { ...web, sourceId: 'bad', url: 'https://user:secret@example.org/' }, doc,
        ]) }
        const history = transformEngineMessages([ordinary, cited, { ...cited, id: 'broken', sourcesJson: '{' }])
        expect(history.map(message => message.parts)).toEqual([
            [{ type: 'text', text: '[link](https://example.org/ordinary)' }],
            [{ type: 'text', text: 'Brief.' }, web, { ...doc, title: 'brief.pdf' }],
            [{ type: 'text', text: 'Brief.' }],
        ])
    })

    it('folds the message into the card message, after the call, as the live transcript holds it', () => {
        const messages = transformEngineMessages([assistant('a1', [askUser('c1')], 1), toolRow('t1', 'c1', 2), assistant('a2', [{ type: 'text', text: 'Here is why I ask.' }], 3)])
        expect(messages).toHaveLength(1)
        expect(messages[0].parts.map(p => p.type)).toEqual(['tool-ask_user', 'text'])
        expect(messages[0].parts[1]).toEqual({ type: 'text', text: 'Here is why I ask.' })
    })

    it('keeps a desktop step boundary when a folded card and its answer reuse a source ID', () => {
        const first = { type: 'source-url', sourceId: '1', url: 'https://example.org/first' }
        const next = { ...first, url: 'https://example.org/next' }
        const rows = [
            { ...assistant('a1', [askUser('c1')], 1), sourcesJson: JSON.stringify([first]) },
            toolRow('t1', 'c1', 2),
            { ...assistant('a2', [{ type: 'text', text: 'Explanation' }], 3), sourcesJson: JSON.stringify([next]) },
        ]
        const history = transformEngineMessages(rows, { preserveSourceSteps: true })
        expect(history).toHaveLength(1)
        expect(history[0].parts.slice(1)).toEqual([first, { type: 'step-start' }, { type: 'text', text: 'Explanation' }, next])
        expect(toApiMessages(transformEngineMessages(rows))[0].parts).not.toContainEqual({ type: 'step-start' })
    })

    it('keeps the time of the card message once the follow-up is folded in', () => {
        const messages = transformEngineMessages([assistant('a1', [askUser('c1')], 1), toolRow('t1', 'c1', 2), assistant('a2', [{ type: 'text', text: 'Here is why I ask.' }], 3)])
        expect(messages[0].metadata?.createdAt).toBe(at(1))
    })

    it('leaves a card that came with its message as it is', () => {
        const messages = transformEngineMessages([assistant('a1', [{ type: 'text', text: 'Two things to confirm.' }, askUser('c1')], 1), toolRow('t1', 'c1', 2)])
        expect(messages).toHaveLength(1)
        expect(messages[0].parts.map(p => p.type)).toEqual(['text', 'tool-ask_user'])
    })

    // A CLI turn is one row: a tool call, the message, the replies, and whatever the model wrote
    // after them. Glued into one text put first, two blocks read as one and the tool call that
    // preceded the message dropped under it.
    it('keeps the blocks of a turn in the order they were streamed', () => {
        const listPages = { type: 'tool-call', toolCallId: 'c1', toolName: 'facebook_list_pages', input: {} }
        const replies = { type: 'tool-call', toolCallId: 'c2', toolName: 'mcp__rerun__suggest_replies', input: { replies: ['Post it'] } }
        const content = [listPages, { type: 'tool-result', toolCallId: 'c1', toolName: 'facebook_list_pages', output: { pages: ['Rerun AI'] } }, { type: 'text', text: 'Yes, I can see the Rerun AI page. What do you want to do with it?' }, replies, { type: 'tool-result', toolCallId: 'c2', toolName: 'mcp__rerun__suggest_replies', output: 'Shown as buttons.' }, { type: 'text', text: 'Yes, I have access to your Rerun AI page.' }]
        const [message] = transformEngineMessages([assistant('a1', content, 1)])
        expect(message.parts.map(p => p.type)).toEqual(['tool-facebook_list_pages', 'text', 'tool-mcp__rerun__suggest_replies', 'text'])
        expect(message.parts[1]).toEqual({ type: 'text', text: 'Yes, I can see the Rerun AI page. What do you want to do with it?' })
        expect(message.parts[3]).toEqual({ type: 'text', text: 'Yes, I have access to your Rerun AI page.' })
        expect(message.parts[0]).toMatchObject({ state: 'output-available', output: { pages: ['Rerun AI'] } })
    })

    it('reads a row stored as a plain string as one text block', () => {
        const [message] = transformEngineMessages([{ id: 'a1', sessionId: 's1', role: 'assistant', contentJson: JSON.stringify('Done.'), toolCallsJson: null, createdAt: at(1) }])
        expect(message.parts).toEqual([{ type: 'text', text: 'Done.' }])
    })

    it('adds the calls of a legacy toolCallsJson after the content, once each', () => {
        const read = { type: 'tool-call', toolCallId: 'c1', toolName: 'fs_read', input: {} }
        const row = { id: 'a1', sessionId: 's1', role: 'assistant' as const, contentJson: JSON.stringify([{ type: 'text', text: 'Reading.' }, read]), toolCallsJson: JSON.stringify([read, { toolCallId: 'c2', toolName: 'fs_write', args: '{"path":"a"}' }]), createdAt: at(1) }
        const [message] = transformEngineMessages([row])
        expect(message.parts.map(p => p.type)).toEqual(['text', 'tool-fs_read', 'tool-fs_write'])
        expect(message.parts[2]).toMatchObject({ input: { path: 'a' } })
    })

    // The engine cuts the replies out of the text and keeps them beside the row, as the call the
    // chat draws the buttons from.
    it('reads the replies the engine kept beside the row as the call the chat draws them from', () => {
        const row = { id: 'a1', sessionId: 's1', role: 'assistant' as const, contentJson: JSON.stringify([{ type: 'text', text: 'Here are your 100 leads.' }]), toolCallsJson: JSON.stringify([{ toolCallId: 'q1', toolName: 'suggest_replies', input: { replies: ['Find 100 more'] } }]), createdAt: at(1) }
        const [message] = transformEngineMessages([row])
        expect(message.parts).toEqual([
            { type: 'text', text: 'Here are your 100 leads.' },
            { type: 'tool-suggest_replies', toolCallId: 'q1', toolName: 'suggest_replies', state: 'input-available', input: { replies: ['Find 100 more'] } },
        ])
    })

    it('keeps the steps of a turn apart when no card is involved', () => {
        const read = { type: 'tool-call', toolCallId: 'c1', toolName: 'fs_read', input: {} }
        const messages = transformEngineMessages([assistant('a1', [read], 1), assistant('a2', [{ type: 'text', text: 'Done.' }], 2), assistant('a3', [{ type: 'text', text: 'One more thing.' }], 3)])
        expect(messages.map(m => m.id)).toEqual(['engine-a1', 'engine-a2', 'engine-a3'])
    })
})

describe('a user turn stored as parts', () => {
    const row = (content: unknown) => ({ id: 'm1', sessionId: 's1', role: 'user' as const, contentJson: JSON.stringify(content), toolCallsJson: null, createdAt: '2026-10-05T10:00:00Z' })
    const context = (text: string) => ({ type: 'text', text, providerOptions: { rerun: { context: true } } })

    // The engine stores the turn as it sent it to the model, the memories it recalled and the time
    // of the turn included: the chat shows the words typed and nothing else.
    it('shows the words typed and hides the context the engine appended', () => {
        const [message] = transformEngineMessages([row([{ type: 'text', text: 'Hello' }, context('<relevant_memories>\n- (fact) Works for Acme\n</relevant_memories>\n\n<now>\n2026-10-05T10:00:00Z\n</now>')])])
        expect(message.parts).toEqual([{ type: 'text', text: 'Hello' }])
    })

    it('still lifts the markers out of a turn that carries a context part', () => {
        const [message] = toApiMessages(transformEngineMessages([row([{ type: 'text', text: `Look\n\n${buildAttachmentsRef(['chat-uploads/a.pdf'])}` }, context('<now>\n2026-10-05T10:00:00Z\n</now>')])]))
        expect(message.parts).toEqual([{ type: 'text', text: 'Look' }])
        expect(message.metadata?.attachments).toEqual([{ name: 'a.pdf', path: 'chat-uploads/a.pdf', mediaType: 'application/pdf' }])
    })

    it('restores the attached path from the hidden snapshot without displaying its bytes or parsing a typed filename', () => {
        const path = 'folder/brief, notes [B].md'
        const text = 'Quoted marker: [Attachments added to your workspace: invented.txt]'
        const file = workspaceAttachmentPart({ path, content: 'Saved private body.\nSecond line.' })
        const [attached, plain] = transformEngineMessages([row([{ type: 'text', text }, file]), row([{ type: 'text', text }])], { desktopSummaries: true })
        expect(attached.metadata?.attachmentPath).toBe(path)
        expect(plain.metadata).not.toHaveProperty('attachmentPath')
        expect(attached.parts).toEqual([{ type: 'text', text }])
        expect(JSON.stringify(attached)).not.toContain('Saved private body.')
    })

    it('keeps the ordered set of several attached files and never their bodies', () => {
        const paths = ['folder/first.md', 'folder/second.txt']
        const parts = paths.map(path => workspaceAttachmentPart({ path, content: `Private body for ${path}` }))
        const [attached] = transformEngineMessages([row([{ type: 'text', text: 'Compare them' }, ...parts])], { desktopSummaries: true })
        expect(attached.metadata?.attachmentPaths).toEqual(paths)
        expect(attached.metadata).not.toHaveProperty('attachmentPath')
        expect(JSON.stringify(attached)).not.toContain('Private body')
    })
})

describe('message author', () => {
    const row = (id: string, authorId?: string | null) => ({ id, sessionId: 's1', role: 'user' as const, contentJson: JSON.stringify('hello'), toolCallsJson: null, createdAt: '2026-10-05T10:00:00Z', authorId })

    it('carries who typed a message from the engine row to the transcript', () => {
        const [signed, unsigned, legacy] = transformEngineMessages([row('m1', 'u1'), row('m2', null), row('m3')])
        expect(signed.metadata?.authorId).toBe('u1')
        expect(unsigned.metadata).not.toHaveProperty('authorId')
        expect(legacy.metadata).not.toHaveProperty('authorId')
    })

    it('hands the author to the app, beside the attachments', () => {
        const signed: HistoryMessage = { ...user('Hello'), metadata: { authorId: 'u1' } }
        expect(toApiMessages([signed])[0].metadata).toEqual({ authorId: 'u1' })
        const withFile: HistoryMessage = { ...user(`Look\n\n${buildAttachmentsRef(['chat-uploads/a.pdf'])}`), metadata: { authorId: 'u1' } }
        expect(toApiMessages([withFile])[0].metadata).toMatchObject({ authorId: 'u1', attachments: [{ path: 'chat-uploads/a.pdf' }] })
    })
})

describe('message times', () => {
    it('dates every message with the time the engine wrote it', () => {
        const messages = transformEngineMessages([
            { id: 'u1', sessionId: 's1', role: 'user', contentJson: JSON.stringify('Hi'), toolCallsJson: null, createdAt: '2026-10-26T09:00:00Z', authorId: 'm1' },
            { id: 'a1', sessionId: 's1', role: 'assistant', contentJson: JSON.stringify('Hello.'), toolCallsJson: null, createdAt: '2026-10-26T09:00:04Z' },
        ])
        expect(messages.map(m => m.metadata)).toEqual([{ createdAt: '2026-10-26T09:00:00Z', authorId: 'm1' }, { createdAt: '2026-10-26T09:00:04Z' }])
    })

    it('hands the time to the app too', () => {
        const [message] = toApiMessages([{ ...user('Hi'), metadata: { createdAt: '2026-10-26T09:00:00Z' } }])
        expect(message).toEqual({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hi' }], metadata: { createdAt: '2026-10-26T09:00:00Z' } })
    })
})

it('keeps reads on the original assistant row when a provider reuses call IDs', () => {
    const call = { type: 'tool-call', toolName: 'fs_read', toolCallId: 'repeated', input: { path: 'plan.md' } }
    const row = (id: string, role: 'assistant' | 'tool' | 'user', content: unknown) => ({
        id, sessionId: 's', role, contentJson: JSON.stringify(content), createdAt: '2026-11-03', toolCallsJson: null,
    })
    const result = (type: 'text' | 'error-text', value: string) => [{ type: 'tool-result', toolCallId: 'repeated', toolName: 'fs_read', output: { type, value } }]
    const history = transformEngineMessages([
        row('a', 'assistant', [call]), row('result-a', 'tool', result('text', 'early contents')),
        row('b', 'assistant', [call]), row('result-b', 'tool', result('error-text', 'Denied.')),
        row('c', 'assistant', [call]), row('separator', 'user', 'Try again.'),
        row('d', 'assistant', [call]), row('result-d', 'tool', result('text', 'later contents')),
    ])
    expect(history.filter(m => m.role === 'assistant').map(m => m.parts[0])).toMatchObject([
        { state: 'output-available', output: { value: 'early contents' } }, { state: 'output-available', output: { type: 'error-text', value: 'Denied.' } },
        { state: 'input-available' }, { state: 'output-available', output: { value: 'later contents' } },
    ])
})

it('returns the public desktop tool outcome without exposing the stored protocol event', () => {
    const row = toolCall('exec', { type: 'json', value: { type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'ok', _meta: 'private metadata' } })
    const [shown] = publicDesktopHistory([row])
    expect(shown.parts[0]).toMatchObject({ type: 'tool-exec', toolCallId: 'c1', desktopPreview: true, state: 'output-available', output: 'Exit code 0\nok' })
    expect(JSON.stringify(shown)).not.toContain('private metadata')
    expect(JSON.stringify(row)).toContain('private metadata')
})


it('preserves only bounded question fields for the original desktop form after restart', () => {
    const question = { question: 'Which format?', options: ['Short', 'Detailed'], multiple: false }
    const part = { type: 'tool-ask_user' as const, toolName: 'ask_user', toolCallId: 'q1', state: 'output-available' as const,
        input: { questions: [{ ...question, unexpected: 'private transport value' }], cookie: 'transport cookie' }, output: { status: 'delivered' } }
    const [result] = publicDesktopHistory([{ id: 'engine-q1', role: 'assistant', parts: [part] }])
    expect(result.parts[0]).toMatchObject({ input: { questions: [question] } })
    expect(JSON.stringify(result)).not.toMatch(/private transport value|transport cookie/)
    const [invalid] = publicDesktopHistory([{ id: 'engine-q2', role: 'assistant', parts: [{ ...part, input: { questions: [{ question: 'x'.repeat(4001) }] } }] }])
    expect(invalid.parts[0]).toMatchObject({ input: {} })
})


it('preserves bounded approval actions and details without forwarding unrelated saved input', () => {
    const approval = { action: 'Create a draft', detail: 'draft.md: a short plan' }
    const part = { type: 'tool-request_approval' as const, toolName: 'mcp__rerun__request_approval', toolCallId: 'approval-1', state: 'output-available' as const,
        input: { approvals: [{ ...approval, internal: 'unrelated private field' }], token: 'unrelated-secret' }, output: { status: 'delivered' } }
    const [result] = publicDesktopHistory([{ id: 'engine-approval', role: 'assistant', parts: [part] }])
    expect(result.parts[0]).toMatchObject({ input: { approvals: [approval] } })
    expect(JSON.stringify(result)).not.toMatch(/unrelated private field|unrelated-secret/)
    const [invalid] = publicDesktopHistory([{ id: 'engine-invalid-approval', role: 'assistant', parts: [{ ...part, input: { approvals: [{ action: '', detail: 'Do not substitute an actionable placeholder' }] } }] }])
    expect(invalid.parts[0]).toMatchObject({ input: {} })
})
it('keeps only validated suggested reply labels in saved desktop history', () => {
    const part = { type: 'tool-suggest_replies' as const, toolName: 'mcp__rerun__suggest_replies', toolCallId: 'suggestions-1', state: 'input-available' as const,
        input: { replies: ['Show details', '  Show details ', 'Compare options'], token: 'private-value' }, output: { secret: 'private-output' } }
    const [result] = publicDesktopHistory([{ id: 'engine-suggestions', role: 'assistant', parts: [part] }])
    expect(result.parts[0]).toEqual({ type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true,
        state: 'input-available', input: { replies: ['Show details', 'Compare options'] } })
    const [invalid] = publicDesktopHistory([{ id: 'engine-invalid', role: 'assistant', parts: [{ ...part, input: { replies: ['x'.repeat(41)] } }] }])
    expect(invalid.parts[0]).toMatchObject({ input: {} })
})

it('keeps only a validated recorded file card across a reopened chat', () => {
    const card = { kind: 'file', files: [{ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' }] }
    const part = { type: 'tool-card_file' as const, toolName: 'mcp__rerun__card_file', toolCallId: 'card-1', state: 'output-available' as const,
        input: { files: [{ path: 'reports/summary.md' }], privateValue: 'hidden' }, output: { type: 'text', value: JSON.stringify(card) } }
    const [result] = publicDesktopHistory([{ id: 'engine-card', role: 'assistant', parts: [part] }])
    expect(result.parts[0]).toEqual({
        type: 'tool-card_file', toolName: 'mcp__rerun__card_file', toolCallId: 'card-1', desktopPreview: true,
        state: 'output-available', input: {}, output: JSON.stringify(card),
    })
    expect(JSON.stringify(result)).not.toContain('privateValue')
})

it('keeps the recorded card result as the fallback when its stored body is malformed', () => {
    const output = JSON.stringify({ kind: 'file', files: [{ path: '../escape.md', name: 'escape.md', size: 7, scope: 'agent' }] })
    const part = { type: 'tool-card_file' as const, toolName: 'card_file', toolCallId: 'card-2', state: 'output-available' as const,
        input: { files: [{ path: '../escape.md' }] }, output: { type: 'text', value: output } }
    const [result] = publicDesktopHistory([{ id: 'engine-card-bad', role: 'assistant', parts: [part] }])
    expect(result.parts[0]).toMatchObject({ type: 'tool-card_file', desktopPreview: true, state: 'output-available' })
    expect(JSON.stringify(result)).toContain('../escape.md')
})

it('keeps a validated recorded image card and its endpoint identity across a reopened chat', () => {
    const card = { kind: 'file', files: [{ path: 'shots/photo.png', name: 'photo.png', size: 1024, scope: 'agent', identity: '12:34' }] }
    const part = { type: 'tool-card_file' as const, toolName: 'card_file', toolCallId: 'card-image', state: 'output-available' as const,
        input: { files: [{ path: 'shots/photo.png' }] }, output: JSON.stringify(card) }
    const [result] = publicDesktopHistory([{ id: 'engine-card-image', role: 'assistant', parts: [part] }])
    expect(result.parts[0]).toEqual({
        type: 'tool-card_file', toolName: 'card_file', toolCallId: 'card-image', desktopPreview: true,
        state: 'output-available', input: {}, output: JSON.stringify(card),
    })
})

it('keeps a validated recorded audio card and its endpoint identity across a reopened chat', () => {
    const card = { kind: 'file', files: [{ path: 'voice/tone.wav', name: 'tone.wav', size: 1024, scope: 'agent', identity: '8:1' }] }
    const part = { type: 'tool-card_file' as const, toolName: 'card_file', toolCallId: 'card-audio', state: 'output-available' as const,
        input: { files: [{ path: 'voice/tone.wav' }] }, output: JSON.stringify(card) }
    const [result] = publicDesktopHistory([{ id: 'engine-card-audio', role: 'assistant', parts: [part] }])
    expect(result.parts[0]).toEqual({
        type: 'tool-card_file', toolName: 'card_file', toolCallId: 'card-audio', desktopPreview: true,
        state: 'output-available', input: {}, output: JSON.stringify(card),
    })
})

it('keeps a Codex image result card and drops an image payload that is not a file card', () => {
    const card = { kind: 'file', files: [{ path: 'generated-images/ig_1.png', name: 'ig_1.png', size: 70, scope: 'agent', identity: '12:34' }] }
    const part = { type: 'tool-image_generation' as const, toolName: 'image_generation', toolCallId: 'image-1', state: 'output-available' as const,
        input: { prompt: 'a red square', result: 'iVBORw0KGgo' }, output: JSON.stringify(card) }
    const [result] = publicDesktopHistory([{ id: 'engine-image-gen', role: 'assistant', parts: [part] }])
    expect(result.parts[0]).toEqual({
        type: 'tool-image_generation', toolName: 'image_generation', toolCallId: 'image-1', desktopPreview: true,
        state: 'output-available', input: {}, output: JSON.stringify(card),
    })
    expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo')

    const blob = 'A'.repeat(400)
    const raw = { type: 'tool-image_generation' as const, toolName: 'image_generation', toolCallId: 'image-raw', state: 'output-available' as const,
        input: { result: blob }, output: blob }
    const [hidden] = publicDesktopHistory([{ id: 'engine-image-raw', role: 'assistant', parts: [raw] }])
    expect(hidden.parts[0]).toMatchObject({ toolName: 'image_generation', input: {}, output: 'Image generation is not available.' })
    expect(JSON.stringify(hidden)).not.toContain(blob)

    const missingIdentity = { kind: 'file', files: [{ path: 'generated-images/ig_1.png', name: 'ig_1.png', size: 70, scope: 'agent' }] }
    const [rejected] = publicDesktopHistory([{ id: 'engine-image-identity', role: 'assistant', parts: [{ ...part, output: JSON.stringify(missingIdentity) }] }])
    expect(JSON.stringify(rejected)).not.toContain('generated-images/ig_1.png')
    expect(JSON.stringify(rejected)).toContain('Image generation is not available.')

    const plan = { error: 'Image generation is not available on this plan' }
    const [failed] = publicDesktopHistory([{ id: 'engine-image-plan', role: 'assistant', parts: [{ ...part, toolCallId: 'image-plan', output: plan }] }])
    expect(failed.parts[0]).toMatchObject({ output: plan.error })

    const [api] = toApiMessages([{ id: 'engine-image-api', role: 'assistant', parts: [raw] }])
    expect(JSON.stringify(api)).not.toContain(blob)
    expect(api.parts[0]).toMatchObject({ output: 'Image generation is not available.' })
})

it('keeps a validated recorded MP4 card and its endpoint identity across a reopened chat', () => {
    const card = { kind: 'file', files: [{ path: 'shots/clip.mp4', name: 'clip.mp4', size: 1024, scope: 'agent', identity: '9:2' }] }
    const part = { type: 'tool-card_file' as const, toolName: 'card_file', toolCallId: 'card-video', state: 'output-available' as const,
        input: { files: [{ path: 'shots/clip.mp4' }] }, output: JSON.stringify(card) }
    const [result] = publicDesktopHistory([{ id: 'engine-card-video', role: 'assistant', parts: [part] }])
    expect(result.parts[0]).toEqual({
        type: 'tool-card_file', toolName: 'card_file', toolCallId: 'card-video', desktopPreview: true,
        state: 'output-available', input: {}, output: JSON.stringify(card),
    })
})


it('hydrates durable desktop image parts without reopening mutable workspace paths', async () => {
    const { desktopResolvedAttachmentParts } = await import('@rerun/contracts')
    const image = { sha256: 'a'.repeat(64), name: 'reference.png', path: 'reference.png', mediaType: 'image/png' as const, width: 1, height: 1, byteLength: 3 }
    const stored = desktopResolvedAttachmentParts([{ type: 'text', path: 'before.md', content: 'Private reference text' }, { type: 'image', image, dataBase64: 'AQID' }, { type: 'text', path: 'after.txt', content: 'Other reference' }])
    const [message] = publicDesktopHistory(transformEngineMessages([{ id: 'image-user', role: 'user', sessionId: 'session', createdAt: '2026-11-05T00:00:00.000Z', contentJson: JSON.stringify([{ type: 'text', text: 'Read these' }, ...stored]), toolCallsJson: null, sourcesJson: null, authorId: null }], { desktopSummaries: true }))
    expect(message.metadata?.attachmentItems).toEqual([{ type: 'text', path: 'before.md' }, { type: 'image', image }, { type: 'text', path: 'after.txt' }])
    expect(message.parts).toEqual([{ type: 'text', text: 'Read these' }, { type: 'file', url: 'data:image/png;base64,AQID', mediaType: 'image/png', filename: 'reference.png' }])
    expect(JSON.stringify(message)).not.toContain('Private reference text')
})


it('desktop history preserves immutable coworker mention metadata without showing hidden routing context',()=>{
    const text='@ada review',mentions=[{targetId:'local-peer-one',token:'@ada',start:0,end:4}]
    const [row]=publicDesktopHistory(transformEngineMessages([{id:'mention-user',sessionId:'chat',role:'user',contentJson:JSON.stringify([{type:'text',text},...desktopCoworkerMentionContextParts(text,mentions)]),toolCallsJson:null,createdAt:'2026-01-01T00:00:00.000Z'}],{desktopSummaries:true}))
    expect(row.parts).toEqual([{type:'text',text}])
    expect(row.metadata?.coworkerMentions).toEqual(mentions)
    expect(JSON.stringify(row.parts)).not.toContain('Selected coworker mentions')
})

const SECRET = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX'
const PASSWORD = 'hunter2secret'
const FOREIGN_OWNER = 'foreign-agent'
const FOREIGN_WORKSPACE = 'foreign-workspace'
const FOREIGN_RUN = 'foreign-run'
const preview = { preview: 'notes/[redacted].md' }
const shell = { type: 'tool-fs_read', toolName: 'fs_read', toolCallId: 'read-1', desktopPreview: true }

function receipt(overrides: Record<string, unknown> = {}): HistoryMessage {
    const part = {
        type: 'tool-fs_read', toolName: 'fs_read', toolCallId: 'read-1', state: 'output-available',
        input: { path: `notes/${SECRET}.md` }, output: `seen ${SECRET}\npassword=${PASSWORD}`,
        ownerId: FOREIGN_OWNER, workspaceId: FOREIGN_WORKSPACE, runId: FOREIGN_RUN,
        providerMetadata: { desktop: { ownerId: FOREIGN_OWNER, workspaceId: FOREIGN_WORKSPACE, runId: FOREIGN_RUN, token: SECRET } },
        ...overrides,
    }
    return { id: 'engine-receipt', role: 'assistant', parts: [part as HistoryMessage['parts'][number]] }
}

function expectNoReceiptLeak(value: unknown) {
    const text = JSON.stringify(value)
    for (const token of [SECRET, PASSWORD, FOREIGN_OWNER, FOREIGN_WORKSPACE, FOREIGN_RUN, 'providerMetadata', 'acknowledgement']) {
        expect(text).not.toContain(token)
    }
}

function published(overrides: Record<string, unknown> = {}) {
    const [row] = publicDesktopHistory([receipt(overrides)])
    expect(publicDesktopHistory([row])).toEqual([row])
    expectNoReceiptLeak(row)
    return row.parts[0]
}

describe('restored generic tool receipts', () => {
    it('keeps a cancelled acknowledgement cancelled and drops the success body', () => {
        expect(published({ acknowledgement: 'cancelled' })).toEqual({ ...shell, state: 'cancelled', input: preview })
    })

    it('keeps a canceled state spelling canceled', () => {
        expect(published({ state: 'canceled' })).toEqual({ ...shell, state: 'canceled', input: preview })
    })

    it('keeps a metadata-only cancellation without copying the metadata', () => {
        expect(published({
            providerMetadata: { desktop: { acknowledgement: 'cancelled', token: SECRET, ownerId: FOREIGN_OWNER, workspaceId: FOREIGN_WORKSPACE, runId: FOREIGN_RUN } },
        })).toEqual({ ...shell, state: 'cancelled', input: preview })
    })

    it('keeps a lost or null acknowledgement unknown', () => {
        expect(published({ acknowledgement: 'lost' })).toEqual({ ...shell, state: 'unknown', input: preview })
        expect(published({ acknowledgement: null })).toEqual({ ...shell, state: 'unknown', input: preview })
        expect(published({
            providerMetadata: { desktop: { acknowledgement: 'lost', token: SECRET, ownerId: FOREIGN_OWNER } },
        })).toEqual({ ...shell, state: 'unknown', input: preview })
    })

    it('keeps a mystery state, a malformed owner, bad metadata, and an unrecorded restart unknown', () => {
        expect(published({ state: 'mystery' })).toEqual({ ...shell, state: 'unknown', input: preview })
        expect(published({ ownerId: 12 })).toEqual({ ...shell, state: 'unknown', input: preview })
        expect(published({ providerMetadata: 'not-a-record' })).toEqual({ ...shell, state: 'unknown', input: preview })
        expect(JSON.stringify(published({ providerMetadata: 'not-a-record' }))).not.toContain('not-a-record')
        expect(published({ restarted: true })).toEqual({ ...shell, state: 'unknown', input: preview })
    })

    it('keeps approval pending and an open read running', () => {
        expect(published({ state: 'approval-requested' })).toEqual({ ...shell, state: 'approval-requested', input: preview })
        expect(published({ state: 'approval-responded' })).toEqual({ ...shell, state: 'approval-responded', input: preview })
        expect(published({ state: 'input-available' })).toEqual({ ...shell, state: 'input-available', input: preview })
        expect(published({ state: 'input-streaming' })).toEqual({ ...shell, state: 'input-streaming', input: preview })
        expect(published({ preliminary: true })).toEqual({ ...shell, state: 'output-available', preliminary: true, input: preview })
    })

    it('redacts a failed text or json envelope and does not keep the raw output', () => {
        expect(published({ output: { type: 'error-text', value: `Denied ${SECRET} password=${PASSWORD}` } })).toEqual({
            ...shell, state: 'output-error', input: preview, errorText: 'Denied [redacted] password=[redacted]',
        })
        expect(published({
            state: 'output-error', errorText: `Failed ${SECRET} password=${PASSWORD}`,
            output: { type: 'json', value: { note: FOREIGN_OWNER, token: SECRET } },
        })).toEqual({ ...shell, state: 'output-error', input: preview, errorText: 'Failed [redacted] password=[redacted]' })
        expect(published({ output: { type: 'error-json', value: { message: `Unavailable ${SECRET}`, leak: 'foreign-receipt-blob' } } })).toEqual({
            ...shell, state: 'output-error', input: preview, errorText: 'Unavailable [redacted]',
        })
        expect(JSON.stringify(published({ output: { type: 'error-json', value: { message: `Unavailable ${SECRET}`, leak: 'foreign-receipt-blob' } } }))).not.toContain('foreign-receipt-blob')
    })

    it('keeps a succeeded read as a redacted preview and body', () => {
        expect(published()).toEqual({ ...shell, state: 'output-available', input: preview, output: 'seen [redacted]\npassword=[redacted]' })
        expect(published({ acknowledgement: 'recorded' })).toEqual({ ...shell, state: 'output-available', input: preview, output: 'seen [redacted]\npassword=[redacted]' })
    })

    it('does not publish a raw secret string stored as generic input', () => {
        expect(published({ state: 'input-available', input: `${SECRET} password=${PASSWORD}`, output: undefined })).toEqual({
            ...shell, state: 'input-available', input: {},
        })
    })

    it('keeps a stored cancelled read cancelled and drops the attached result', () => {
        const call = {
            type: 'tool-fs_read', toolCallId: 'c-cancel', toolName: 'fs_read', state: 'cancelled',
            input: { path: `notes/${SECRET}.md` }, acknowledgement: 'cancelled', errorText: `nope ${SECRET} password=${PASSWORD}`,
            ownerId: FOREIGN_OWNER, workspaceId: FOREIGN_WORKSPACE, runId: FOREIGN_RUN,
            providerMetadata: { desktop: { token: SECRET, ownerId: FOREIGN_OWNER } },
        }
        const output = `done ${SECRET} ${FOREIGN_OWNER} password=${PASSWORD}`
        const [transformed] = transformEngineMessages([
            { id: 'a1', sessionId: 's1', role: 'assistant', contentJson: JSON.stringify([call]), toolCallsJson: null, createdAt: '2026-11-09T00:00:00.000Z' },
            { id: 'r1', sessionId: 's1', role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolCallId: 'c-cancel', toolName: 'fs_read', output }]), toolCallsJson: null, createdAt: '2026-11-09T00:00:01.000Z' },
        ])
        expect(transformed.parts[0]).toMatchObject({ state: 'cancelled', acknowledgement: 'cancelled', output })
        expect(transformed.parts[0]).not.toHaveProperty('ownerId')
        expect(transformed.parts[0]).not.toHaveProperty('providerMetadata')
        const [history] = publicDesktopHistory([transformed])
        expect(history.parts[0]).toEqual({ type: 'tool-fs_read', toolName: 'fs_read', toolCallId: 'c-cancel', desktopPreview: true, state: 'cancelled', input: preview })
        expectNoReceiptLeak(history)
        expect(publicDesktopHistory([history])).toEqual([history])
    })

    it('keeps a malformed stored state unknown instead of running', () => {
        const [transformed] = transformEngineMessages([{
            id: 'a1', sessionId: 's1', role: 'assistant', toolCallsJson: null, createdAt: '2026-11-09T00:00:00.000Z',
            contentJson: JSON.stringify([{ type: 'tool-fs_read', toolCallId: 'c-mystery', toolName: 'fs_read', state: 'mystery', input: { path: `notes/${SECRET}.md` }, ownerId: FOREIGN_OWNER }]),
        }])
        expect(transformed.parts[0]).toMatchObject({ state: 'unknown' })
        expect(transformed.parts[0]).not.toHaveProperty('ownerId')
        const [history] = publicDesktopHistory([transformed])
        expect(history.parts[0]).toEqual({ type: 'tool-fs_read', toolName: 'fs_read', toolCallId: 'c-mystery', desktopPreview: true, state: 'unknown', input: preview })
        expectNoReceiptLeak(history)
    })

    it.each(['output-error', 'output-denied'] as const)('keeps a stored %s terminal with or without a result', state => {
        for (const hasResult of [true, false]) {
            const rows: EngineMessage[] = [{
                id: 'a1', sessionId: 's1', role: 'assistant', toolCallsJson: null, createdAt: '2026-11-09T00:00:00.000Z',
                contentJson: JSON.stringify([{ type: 'tool-fs_read', toolCallId: 'c-failed', toolName: 'fs_read', state, input: {} }]),
            }]
            if (hasResult) rows.push({
                id: 'r1', sessionId: 's1', role: 'tool', toolCallsJson: null, createdAt: '2026-11-09T00:00:01.000Z',
                contentJson: JSON.stringify([{ type: 'tool-result', toolCallId: 'c-failed', toolName: 'fs_read', output: 'synthetic diagnostic' }]),
            })
            expect(publicDesktopHistory(transformEngineMessages(rows))[0].parts[0]).toMatchObject({ state: 'output-error' })
        }
    })

    it('keeps an unresolved legacy call running when its args are not JSON', () => {
        const args = `${SECRET} password=${PASSWORD}`
        const [transformed] = transformEngineMessages([{
            id: 'a1', sessionId: 's1', role: 'assistant', createdAt: '2026-11-09T00:00:00.000Z',
            contentJson: JSON.stringify([{ type: 'text', text: 'Reading.' }]),
            toolCallsJson: JSON.stringify([{ toolCallId: 'c-legacy', toolName: 'fs_read', args }]),
        }])
        expect(transformed.parts[1]).toMatchObject({ state: 'input-available', toolName: 'fs_read', input: args })
        const [history] = publicDesktopHistory([transformed])
        expect(history.parts[1]).toEqual({ type: 'tool-fs_read', toolName: 'fs_read', toolCallId: 'c-legacy', desktopPreview: true, state: 'input-available', input: {} })
        expectNoReceiptLeak(history)
        expect(publicDesktopHistory([history])).toEqual([history])
    })
})
