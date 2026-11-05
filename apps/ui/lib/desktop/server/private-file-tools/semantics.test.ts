import {describe,it,expect} from 'vitest'
import {privateTextPath,boundedPrivateText,editPrivateText} from './semantics'
describe('Rerun private fs_write/fs_edit semantics',()=>{
 it('uses literal strings, unique matches by default and explicit replaceAll',()=>{
  expect(editPrivateText('a $& a','a','$1',true)).toEqual({content:'$1 $& $1',occurrences:2})
  expect(()=>editPrivateText('aa','a','b')).toThrow('matches 2')
  expect(()=>editPrivateText('abc','','x',true)).toThrow('empty')
  expect(()=>editPrivateText('abc','d','x')).toThrow('not found')
 })
 it('requires visible text paths and bounded complete valid text',()=>{
  for(const path of ['/a.md','../a.md','.secret/a.md','a/.secret.md','a//b.md','a.bin','a\\b.md'])expect(()=>privateTextPath(path)).toThrow()
  expect(privateTextPath('notes/a.md')).toBe('notes/a.md')
  for(const text of ['\0','\ud800','a'.repeat(256*1024+1)])expect(()=>boundedPrivateText(text)).toThrow()
 })
})
