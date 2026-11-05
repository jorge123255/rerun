import { expect, test } from 'vitest'
import { checkedDesktopCoworkerMentions, desktopCoworkerMentionContextParts, desktopStoredCoworkerMentions, trimDesktopCoworkerMentions } from '@rerun/contracts'
import { visibleText } from '@rerun/contracts'

test('trimming shifts selected UTF-16 ranges without replacing the visible token or identity', () => {
    const text='  Ask @ada for help  ',start=text.indexOf('@ada')
    expect(trimDesktopCoworkerMentions(text,[{targetId:'local-original',token:'@ada',start,end:start+4}])).toEqual({text:'Ask @ada for help',coworkerMentions:[{targetId:'local-original',token:'@ada',start:4,end:8}]})
})
test('saved selected IDs are hidden from visible text and round-trip without resolving renamed names', () => {
    const text='Ask @ada for help',mentions=[{targetId:'local-original',token:'@ada',start:4,end:8}]
    const content=[{type:'text',text},...desktopCoworkerMentionContextParts(text,mentions)]
    expect(visibleText(content,'')).toBe(text)
    expect(desktopStoredCoworkerMentions(JSON.parse(JSON.stringify(content)),true)).toEqual(mentions)
    expect(desktopStoredCoworkerMentions([{type:'text',text:'@ada is ordinary typed text'}],true)).toEqual([])
})
test('invalid ranges and overlapping or duplicate hidden maps are refused', () => {
    const mention={targetId:'local-original',token:'@ada',start:0,end:4}
    expect(()=>checkedDesktopCoworkerMentions('@adaX',[mention])).toThrow()
    expect(()=>checkedDesktopCoworkerMentions('@ada',[mention,mention])).toThrow()
    const part=desktopCoworkerMentionContextParts('@ada',[mention])[0]!
    expect(()=>desktopStoredCoworkerMentions([{type:'text',text:'@ada'},part,part],true)).toThrow()
    expect(()=>desktopStoredCoworkerMentions([{type:'text',text:'Changed'},part],true)).toThrow()
})
