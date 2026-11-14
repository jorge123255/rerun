import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopConnectorActionKind } from '@rerun/contracts'

vi.mock('server-only', () => ({}))
const { initializeDesktopRound61 } = await import('../round61-schema')
const { admitConnectorCall, decideConnectorApproval, forgetConnectorRule, forgetConnectorRuleOf, listConnectorRules, pendingConnectorApproval, readConnectorApprovals } = await import('./store')

let db: Client, dir: string
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'connector-approvals-'))
    db = createClient({ url: `file:${join(dir, 'app.db')}` })
    await db.execute('CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL)')
    await initializeDesktopRound61(db)
    await initializeDesktopRound61(db)
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

const call = (overrides: Partial<Parameters<typeof admitConnectorCall>[1]> = {}) => ({
    owner: 'coworker-1', sessionId: 'chat-1', tool: 'gmail_send_email', kind: 'send' as const, arguments: { to: 'pat@example.test', body: 'Hello' }, ...overrides,
})

describe('which connector actions ask first', () => {
    it('recognizes the action by the tool’s first verb', () => {
        const kinds: [string, string | null][] = [
            ['gmail_send_email', 'send'], ['GMAIL_REPLY_TO_THREAD', 'send'], ['slack_create_message', 'send'], ['calendar_invite_attendee', 'send'],
            ['drive_delete_file', 'delete'], ['GMAIL_MOVE_TO_TRASH', 'delete'], ['GMAIL_SEND_EMAIL', 'send'], ['GMAIL_CREATE_EMAIL_DRAFT', null], ['GMAIL_FETCH_EMAILS', null], ['HUBSPOT_ARCHIVE_CONTACT', 'delete'], ['notion_trash_page', 'delete'], ['gmail_removeLabel', 'delete'],
            ['drive_share_file', 'share'], ['drive_add_permission', 'share'], ['github_add_collaborator', 'share'],
            ['x_create_tweet', 'post'], ['linkedin_publish_article', 'post'], ['github_create_release', 'post'],
            ['stripe_create_refund', 'pay'], ['stripe_charge_customer', 'pay'], ['shop_place_order', 'pay'],
            ['okta_reset_password', 'credential'], ['github_rotate_api_key', 'credential'], ['aws_create_secret', 'credential'],
            // Ordinary reads and changes, and words that only name what is acted on.
            ['gmail_list_messages', null], ['gmail_get_sent_mail', null], ['gmail_create_draft', null], ['calendar_create_event', null],
            ['gmail_mark_comment_as_spam', null], ['x_like_post', null], ['docs_edit_comment', null], ['gmail_cancel_scheduled_send', null],
            ['drive_unarchive_file', null], ['STRIPE_POST_V1_PLANS_OVERVIEW', null], ['notion_update_page', null], ['posts_list', null],
        ]
        for (const [name, kind] of kinds) expect(desktopConnectorActionKind(name), name).toBe(kind)
        expect(desktopConnectorActionKind('gmail_batch_modify_messages', true)).toBe('delete')
        expect(desktopConnectorActionKind('gmail_send_email', true)).toBe('send')
    })
})

describe('holding a connector call until the person answers', () => {
    it('asks once, waits, and lets exactly the allowed call through once', async () => {
        expect(await admitConnectorCall(db, call())).toMatch(/did not run.*card/)
        expect(await admitConnectorCall(db, call())).toMatch(/still waiting/)
        const view = await readConnectorApprovals(db, 'chat-1')
        expect(view.pending).toHaveLength(1)
        expect(view.pending[0]).toMatchObject({ tool: 'gmail_send_email', kind: 'send' })
        expect(view.pending[0]!.preview).toContain('pat@example.test')
        expect(await readConnectorApprovals(db, 'chat-2')).toEqual({ pending: [], rules: [] })

        expect(await decideConnectorApproval(db, 'chat-2', view.pending[0]!.id, 'once')).toBeNull()
        expect(await decideConnectorApproval(db, 'chat-1', view.pending[0]!.id, 'once')).toEqual({ tool: 'gmail_send_email', kind: 'send', decision: 'once' })
        expect(await decideConnectorApproval(db, 'chat-1', view.pending[0]!.id, 'deny')).toBeNull()

        // Other arguments, another chat or another coworker are other calls.
        expect(await admitConnectorCall(db, call({ arguments: { to: 'someone-else@example.test', body: 'Hello' } }))).toMatch(/did not run/)
        expect(await admitConnectorCall(db, call({ sessionId: 'chat-2' }))).toMatch(/did not run/)
        expect(await admitConnectorCall(db, call({ owner: 'coworker-2' }))).toMatch(/did not run/)
        // Key order does not make it another call; the allow is spent by the call it lets through.
        expect(await admitConnectorCall(db, call({ arguments: { body: 'Hello', to: 'pat@example.test' } }))).toBeNull()
        expect(await admitConnectorCall(db, call())).toMatch(/did not run/)
    })

    it('tells the coworker a refusal once and keeps secrets out of the card', async () => {
        await admitConnectorCall(db, call({ tool: 'drive_delete_file', kind: 'delete', arguments: { id: 'f1', token: 'sk-fixture0000000000' } }))
        const [pending] = (await readConnectorApprovals(db, 'chat-1')).pending
        expect(pending!.preview).not.toContain('sk-fixture')
        await decideConnectorApproval(db, 'chat-1', pending!.id, 'deny')
        const again = { tool: 'drive_delete_file', kind: 'delete' as const, arguments: { id: 'f1', token: 'sk-fixture0000000000' } }
        expect(await admitConnectorCall(db, call(again))).toMatch(/declined/)
        expect(await admitConnectorCall(db, call(again))).toMatch(/did not run/)
    })

    it('an answer for the conversation stays in it, and an always answer follows the coworker', async () => {
        await admitConnectorCall(db, call())
        await decideConnectorApproval(db, 'chat-1', (await readConnectorApprovals(db, 'chat-1')).pending[0]!.id, 'conversation')
        expect(await admitConnectorCall(db, call())).toBeNull()
        expect(await admitConnectorCall(db, call({ arguments: { to: 'another@example.test' } }))).toBeNull()
        expect(await admitConnectorCall(db, call({ sessionId: 'chat-2' }))).toMatch(/did not run/)
        expect(await admitConnectorCall(db, call({ tool: 'drive_delete_file', kind: 'delete' }))).toMatch(/did not run/)

        await decideConnectorApproval(db, 'chat-2', (await readConnectorApprovals(db, 'chat-2')).pending[0]!.id, 'always')
        expect(await admitConnectorCall(db, call({ sessionId: 'chat-3' }))).toBeNull()
        expect(await admitConnectorCall(db, call({ owner: 'coworker-2', sessionId: 'chat-3' }))).toMatch(/did not run/)

        const rules = (await readConnectorApprovals(db, 'chat-2')).rules
        expect(rules.map(rule => rule.scope)).toEqual(['always'])
        expect(await forgetConnectorRule(db, 'chat-9', rules[0]!.id)).toBe(false)
        expect(await forgetConnectorRule(db, 'chat-2', rules[0]!.id)).toBe(true)
        expect(await admitConnectorCall(db, call({ sessionId: 'chat-4' }))).toMatch(/did not run/)
        const own = (await readConnectorApprovals(db, 'chat-1')).rules
        expect(own.map(rule => rule.scope)).toEqual(['conversation'])
        expect(await forgetConnectorRule(db, 'chat-1', own[0]!.id)).toBe(true)
        // The call that was shown and allowed still runs once; the next one asks again.
        expect(await admitConnectorCall(db, call())).toBeNull()
        expect(await admitConnectorCall(db, call())).toMatch(/did not run/)
    })

    it('stops adding cards when too many are waiting', async () => {
        for (let index = 0; index < 20; index++) expect(await admitConnectorCall(db, call({ arguments: { index } }))).toMatch(/did not run/)
        expect(await admitConnectorCall(db, call({ arguments: { index: 20 } }))).toMatch(/Too many/)
        expect((await readConnectorApprovals(db, 'chat-1')).pending).toHaveLength(20)
    })

    it('lists a coworker’s standing answers for its settings, and what is waiting for the board', async () => {
        expect(await pendingConnectorApproval(db, 'chat-1')).toBeNull()
        await admitConnectorCall(db, call())
        const waiting = await pendingConnectorApproval(db, 'chat-1')
        expect(waiting).toMatchObject({ tool: 'gmail_send_email' })
        await decideConnectorApproval(db, 'chat-1', waiting!.id, 'always')
        expect(await pendingConnectorApproval(db, 'chat-1')).toBeNull()
        await admitConnectorCall(db, call({ tool: 'drive_delete_file', kind: 'delete' }))
        await decideConnectorApproval(db, 'chat-1', (await pendingConnectorApproval(db, 'chat-1'))!.id, 'conversation')

        const rules = await listConnectorRules(db, 'coworker-1')
        expect(rules.map(rule => [rule.tool, rule.scope])).toEqual([['gmail_send_email', 'always'], ['drive_delete_file', 'conversation']])
        expect(await listConnectorRules(db, 'coworker-2')).toEqual([])
        expect(await forgetConnectorRuleOf(db, 'coworker-2', rules[0]!.id)).toBe(false)
        expect(await forgetConnectorRuleOf(db, 'coworker-1', rules[0]!.id)).toBe(true)
        expect((await listConnectorRules(db, 'coworker-1')).map(rule => rule.tool)).toEqual(['drive_delete_file'])
        expect(await admitConnectorCall(db, call({ sessionId: 'chat-5' }))).toMatch(/did not run/)
    })
})
