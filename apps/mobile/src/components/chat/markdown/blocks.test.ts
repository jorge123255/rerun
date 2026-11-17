import { splitIntoBubbles } from './blocks'

const texts = (markdown: string) => splitIntoBubbles(markdown).map(bubble => bubble.markdown)

describe('splitIntoBubbles', () => {
    it('gives each paragraph its own bubble', () => {
        expect(texts('Done.\n\nThe report is in `reports/q3.md`.\n\nWant me to send it?')).toEqual(['Done.', 'The report is in `reports/q3.md`.', 'Want me to send it?'])
    })

    it('keeps a sentence ending on a colon with the list it introduces', () => {
        expect(texts('Three things stay behind:\n\n- the history\n- the test links\n\nTell me what to do next.')).toEqual(['Three things stay behind:\n\n- the history\n- the test links', 'Tell me what to do next.'])
    })

    it('keeps a loose list in one bubble', () => {
        expect(texts('- one\n\n- two\n\n- three')).toEqual(['- one\n\n- two\n\n- three'])
    })

    it('keeps a heading with the block under it', () => {
        expect(texts('## Next steps\n\nCapture the agent from the sandbox.')).toEqual(['## Next steps\n\nCapture the agent from the sandbox.'])
    })

    it('chains a heading, its lead-in and the list', () => {
        expect(texts('## Left behind\n\nThese do not follow the copy:\n\n- the history')).toEqual(['## Left behind\n\nThese do not follow the copy:\n\n- the history'])
    })

    it('sets code blocks and tables bare, out of any bubble', () => {
        const bubbles = splitIntoBubbles('Run this:\n\n```sh\npnpm build\n\npnpm start\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')
        expect(bubbles).toEqual([
            { markdown: 'Run this:', frame: 'bubble' },
            { markdown: '```sh\npnpm build\n\npnpm start\n```', frame: 'bare' },
            { markdown: '| a | b |\n| --- | --- |\n| 1 | 2 |', frame: 'bare' },
        ])
    })

    it('keeps a whole email draft in one bare block, its paragraphs and lists included', () => {
        const draft = '```draft Email to the recruiter\nBonjour,\n\nJe vous propose ma candidature :\n\n- disponible\n- 600 €/jour\n\nBien à vous\n```'
        expect(splitIntoBubbles(`Here is the email:\n\n${draft}\n\nShall I send it?`)).toEqual([
            { markdown: 'Here is the email:', frame: 'bubble' },
            { markdown: draft, frame: 'bare' },
            { markdown: 'Shall I send it?', frame: 'bubble' },
        ])
    })

    it('sets an image alone out of the bubble of the sentence announcing it', () => {
        expect(splitIntoBubbles('Here is the hero:\n\n![Hero](/hero.png)\n\nWant another?')).toEqual([
            { markdown: 'Here is the hero:', frame: 'bubble' },
            { markdown: '![Hero](/hero.png)', frame: 'media' },
            { markdown: 'Want another?', frame: 'bubble' },
        ])
    })

    it('keeps an image inside a sentence in its bubble', () => {
        expect(splitIntoBubbles('The logo ![Logo](/logo.png) sits top left.')).toEqual([{ markdown: 'The logo ![Logo](/logo.png) sits top left.', frame: 'bubble' }])
    })

    it('breaks on a horizontal rule without drawing it', () => {
        expect(texts('Here is the plan:\n\n---\n\nFirst part.')).toEqual(['Here is the plan:', 'First part.'])
    })

    it('does not treat a list item ending on a colon as a lead-in', () => {
        expect(texts('- Steps:\n\nThen it ran.')).toEqual(['- Steps:', 'Then it ran.'])
    })

    it('keeps a half-streamed code fence whole in the last bubble', () => {
        const bubbles = splitIntoBubbles('Here it is.\n\n```ts\nconst a = 1\n\nconst b')
        expect(bubbles.at(-1)).toEqual({ markdown: '```ts\nconst a = 1\n\nconst b', frame: 'bare' })
    })

    it('returns nothing for blank text', () => {
        expect(splitIntoBubbles('  \n\n ')).toEqual([])
    })

    it('only ever grows the last bubble while an answer streams in', () => {
        const answers = [
            "C'est fait, **Site Cloner** est cloné. Trois choses ne suivent pas la copie :\n\n- **L'historique :** il reste.\n- **Les liens de test :** `/p/craft-demo-readme`.\n- **Le dossier :** 125 Mo.\n\n**À faire de ton côté :** capturer l'agent depuis la sandbox.\n\nDone.",
            '## Deployed\n\nLive on **rerun.build**. Two things changed:\n\n1. Node 22\n2. cached `og/`\n\nRun this:\n\n```sh\npnpm build\n\npnpm start\n```\n\n| Page | Status |\n| --- | --- |\n| / | 200 |\n\n---\n\nWant me to watch it?',
        ]
        for (const answer of answers) {
            let shown = splitIntoBubbles('')
            for (let end = 1; end <= answer.length; end++) {
                const next = splitIntoBubbles(answer.slice(0, end))
                const settled = shown.slice(0, -1)
                expect(next.slice(0, settled.length)).toEqual(settled)
                shown = next
            }
        }
    })
})
