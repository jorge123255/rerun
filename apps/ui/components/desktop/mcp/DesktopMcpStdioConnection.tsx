'use client'
import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import {Field} from '@/components/ui/field'
import {Input} from '@/components/ui/input'
import {PanelDeleteButton,PanelEditorBody,PanelEditorFooter,PanelEditorHeader,PanelEditorShell} from '@/components/ui/panel-editor'
import type {StdioConnection} from '@/lib/desktop/server/mcp-stdio/store'
export type StdioEditorInput={name:string;executable:string;args:string[];revision?:string}
export function DesktopMcpStdioConnection({server,onSave,onDelete,onBack}:{server?:StdioConnection;onSave:(input:StdioEditorInput)=>Promise<void>;onDelete?:()=>Promise<void>;onBack:()=>void}){
 const [name,setName]=useState(server?.name??''),[executable,setExecutable]=useState(server?.executable??''),[args,setArgs]=useState(JSON.stringify(server?.args??[],null,2)),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const pending=useRef(false),alive=useRef(true)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 async function perform(remove=false){
  if(pending.current)return;pending.current=true;setBusy(true);setError('')
  try{
   if(remove){await onDelete?.();return}
   const parsed:unknown=JSON.parse(args)
   if(!Array.isArray(parsed) || parsed.some(value=>typeof value!=='string'))throw new Error()
   await onSave({name,executable,args:parsed as string[],revision:server?.revision})
  }catch{if(alive.current)setError('Local connection could not be saved. Use an installed executable and a JSON array of arguments.')}
  finally{pending.current=false;if(alive.current)setBusy(false)}
 }
 return <PanelEditorShell><PanelEditorHeader title={server?'Edit MCP server':'New MCP server'} onBack={busy?undefined:onBack}/><PanelEditorBody>
  {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
  <Field label="Name" htmlFor="stdio-name" helperText={`Tools are merged as "${name||'name'}_<tool>".`}><Input id="stdio-name" disabled={!!server||busy} value={name} onChange={event=>setName(event.target.value)}/></Field>
  <p className="text-xs">Local subprocess · stdio</p>
  <Field label="Executable" htmlFor="stdio-executable"><Input id="stdio-executable" value={executable} disabled={busy} onChange={event=>setExecutable(event.target.value)} placeholder="/absolute/path/to/installed-server"/></Field>
  <Field label="Arguments (JSON array)" htmlFor="stdio-args"><textarea id="stdio-args" className="w-full min-h-24 rounded border bg-background p-2 font-mono text-xs" value={args} disabled={busy} onChange={event=>setArgs(event.target.value)}/></Field>
  <p className="text-xs text-muted-foreground break-words">This executable runs with your Mac user’s access. A separate saved Local MCP subprocess permission is required for this coworker. No shell, automatic installation, custom environment or provider credentials are supplied. Do not enter secrets in arguments.</p>
  <code className="block whitespace-pre-wrap break-all text-xs">{JSON.stringify({executable,arguments:(()=>{try{return JSON.parse(args)}catch{return args}})()},null,2)}</code>
 </PanelEditorBody><PanelEditorFooter><Button disabled={busy||!name||!executable} onClick={()=>perform()}>Save</Button>{onDelete&&<PanelDeleteButton label="Delete MCP server" disabled={busy} busy={busy} onClick={()=>perform(true)}/>}</PanelEditorFooter></PanelEditorShell>
}
