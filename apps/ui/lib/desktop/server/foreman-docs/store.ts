import 'server-only'
import type { Client, Row } from '@libsql/client'
import { DESKTOP_FOREMAN_DOCS_LIMITS, desktopForemanDocsCorpusSchema, desktopForemanDocsReceiptSchema, desktopForemanDocsResultSchema, type DesktopForemanDocsRequest, type DesktopForemanDocsResult } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { desktopForemanDocsBodyFingerprint, desktopForemanDocsCorpusFingerprint } from './identity'
import type { DesktopForemanDocsCorpusRecord, DesktopForemanDocsStore } from './service'

export const desktopForemanDocsSchemaSql = `
CREATE TABLE IF NOT EXISTS desktop_foreman_docs_corpus (
 corpus_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, corpus_json TEXT NOT NULL,
 body TEXT NOT NULL, fetched_at TEXT NOT NULL, sha256 TEXT NOT NULL,
 byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 1000000),
 version TEXT NOT NULL, publisher_workspace_id TEXT NOT NULL, publisher_chat_id TEXT NOT NULL,
 publisher_run_id TEXT NOT NULL, publisher_tool_call_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_foreman_docs_receipts (
 tool_call_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, chat_id TEXT NOT NULL,
 run_id TEXT NOT NULL, fingerprint TEXT NOT NULL, request_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','completed')), result_json TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_foreman_docs_run_idx ON desktop_foreman_docs_receipts(workspace_id,chat_id,run_id);`

export async function ensureDesktopForemanDocsSchema(db: Client) {
    await db.executeMultiple(desktopForemanDocsSchemaSql)
}

const docsConflict = () => new DesktopHttpError(409, 'This documentation request or corpus changed. Reconcile it before retrying.')
const writes = new WeakMap<Client, Promise<void>>()
async function transaction<T>(db: Client, work: (tx: Awaited<ReturnType<Client['transaction']>>) => Promise<T>): Promise<T> {
    const next = (writes.get(db) ?? Promise.resolve()).then(async () => {
        const tx = await db.transaction('write')
        try {
            const result = await work(tx)
            await tx.commit()
            return result
        } catch (error) {
            await tx.rollback().catch(() => {})
            throw error
        } finally {
            tx.close()
        }
    })
    const tail = next.then(() => {}, () => {})
    writes.set(db, tail)
    void tail.then(() => { if (writes.get(db) === tail) writes.delete(db) })
    return next
}

function receipt(row: Row) {
    const value = desktopForemanDocsReceiptSchema.parse({
        request: JSON.parse(String(row.request_json)),
        fingerprint: row.fingerprint,
        status: row.status,
        result: row.result_json == null ? null : JSON.parse(String(row.result_json)),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    })
    if (value.request.binding.workspaceId !== row.workspace_id || value.request.binding.chatId !== row.chat_id || value.request.binding.runId !== row.run_id || value.request.toolCallId !== row.tool_call_id) throw docsConflict()
    return value
}

function corpus(row: Row): DesktopForemanDocsCorpusRecord {
    return {
        corpus: desktopForemanDocsCorpusSchema.parse(JSON.parse(String(row.corpus_json))),
        fingerprint: String(row.fingerprint),
        body: String(row.body),
        fetchedAt: String(row.fetched_at),
        sha256: String(row.sha256),
        byteLength: Number(row.byte_length),
        version: String(row.version),
        publishedBy: { workspaceId: String(row.publisher_workspace_id), chatId: String(row.publisher_chat_id), runId: String(row.publisher_run_id), toolCallId: String(row.publisher_tool_call_id) },
    }
}

export function desktopForemanDocsStore(db: Client): DesktopForemanDocsStore {
    return {
        reserve: (request, fingerprint, createdAt) => transaction(db, async tx => {
            const previous = (await tx.execute({ sql: 'SELECT * FROM desktop_foreman_docs_receipts WHERE tool_call_id=?', args: [request.toolCallId] })).rows[0]
            if (previous) {
                const value = receipt(previous)
                if (value.fingerprint !== fingerprint) throw docsConflict()
                return { receipt: value, created: false }
            }
            await tx.execute({
                sql: "INSERT INTO desktop_foreman_docs_receipts(tool_call_id,workspace_id,chat_id,run_id,fingerprint,request_json,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',NULL,?,?)",
                args: [request.toolCallId, request.binding.workspaceId, request.binding.chatId, request.binding.runId, fingerprint, JSON.stringify(request), createdAt, createdAt],
            })
            return { receipt: desktopForemanDocsReceiptSchema.parse({ request, fingerprint, status: 'pending', result: null, createdAt, updatedAt: createdAt }), created: true }
        }),
        finish: (request, fingerprint, result, updatedAt) => transaction(db, async tx => {
            const previous = (await tx.execute({ sql: 'SELECT * FROM desktop_foreman_docs_receipts WHERE tool_call_id=?', args: [request.toolCallId] })).rows[0]
            if (!previous) throw docsConflict()
            const value = receipt(previous)
            if (value.fingerprint !== fingerprint) throw docsConflict()
            if (value.result) return value
            const parsed = desktopForemanDocsResultSchema.parse(result)
            const changed = await tx.execute({ sql: "UPDATE desktop_foreman_docs_receipts SET status='completed',result_json=?,updated_at=? WHERE tool_call_id=? AND fingerprint=? AND status='pending'", args: [JSON.stringify(parsed), updatedAt, request.toolCallId, fingerprint] })
            if (changed.rowsAffected !== 1) throw docsConflict()
            return desktopForemanDocsReceiptSchema.parse({ ...value, status: 'completed', result: parsed, updatedAt })
        }),
        async readCorpus(corpusId) {
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_foreman_docs_corpus WHERE corpus_id=?', args: [corpusId] })).rows[0]
            return row ? corpus(row) : null
        },
        publishCorpus: (record, expectedFingerprint) => transaction(db, async tx => {
            if (record.byteLength !== Buffer.byteLength(record.body) || record.byteLength > DESKTOP_FOREMAN_DOCS_LIMITS.maxCorpusBytes || record.sha256 !== desktopForemanDocsBodyFingerprint(record.body) || record.fingerprint !== desktopForemanDocsCorpusFingerprint(record.corpus)) throw docsConflict()
            const previous = (await tx.execute({ sql: 'SELECT fingerprint FROM desktop_foreman_docs_corpus WHERE corpus_id=?', args: [record.corpus.id] })).rows[0]
            if ((previous ? String(previous.fingerprint) : null) !== expectedFingerprint) throw docsConflict()
            await tx.execute({
                sql: `INSERT OR REPLACE INTO desktop_foreman_docs_corpus(corpus_id,fingerprint,corpus_json,body,fetched_at,sha256,byte_length,version,publisher_workspace_id,publisher_chat_id,publisher_run_id,publisher_tool_call_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
                args: [record.corpus.id, record.fingerprint, JSON.stringify(record.corpus), record.body, record.fetchedAt, record.sha256, record.byteLength, record.version, record.publishedBy.workspaceId, record.publishedBy.chatId, record.publishedBy.runId, record.publishedBy.toolCallId],
            })
        }),
    }
}

export function desktopForemanDocsPublisher(request: DesktopForemanDocsRequest): DesktopForemanDocsCorpusRecord['publishedBy'] {
    return { workspaceId: request.binding.workspaceId, chatId: request.binding.chatId, runId: request.binding.runId, toolCallId: request.toolCallId }
}

export function desktopForemanDocsResult(value: unknown): DesktopForemanDocsResult {
    return desktopForemanDocsResultSchema.parse(value)
}

export type { DesktopForemanDocsRequest }
