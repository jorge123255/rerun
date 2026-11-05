'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { PlugIcon, PlusIcon } from '@/lib/icons'
import { PanelListHeader, PanelScroller } from '@/components/ui/panel-list'
import { PanelSteps } from '@/components/ui/panel-steps'
import { PanelDeleteButton, PanelEditorBody, PanelEditorFooter, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import type { RemoteServer } from '@/lib/desktop/server/mcp/model'
import { DesktopMcpStdioConnection } from './DesktopMcpStdioConnection'
import type { StdioConnection } from '@/lib/desktop/server/mcp-stdio/store'
import { DesktopMcpOAuthAuthorize } from './DesktopMcpOAuthAuthorize'

export function DesktopCoworkerMcp({agentId}:{agentId:string}) {
    return <CoworkerMcpPanel key={agentId} agentId={agentId}/>
}
function CoworkerMcpPanel({agentId}:{agentId:string}) {
    const alive = useRef(true), editorEpoch = useRef(0), actionEpoch=useRef(0), listEpoch=useRef(0), localListEpoch=useRef(0)
    useEffect(()=> { alive.current=true; return ()=>{alive.current=false;editorEpoch.current++} },[])
    function navigate(next:RemoteServer | 'new' | null) {setEditingLocal(null);editorEpoch.current++;actionEpoch.current++;setBusy(false);setEditing(next)}
    async function mutate(method:string,input:unknown) {
        actionEpoch.current++;setBusy(false)
        const owner=editorEpoch.current
        const data=await request(method,input)
        if (!alive.current || owner!==editorEpoch.current) return
        listEpoch.current++;setServers(data);setTools({});setError('');navigate(null)
    }
    const [localServers, setLocalServers] = useState<StdioConnection[]>([])
    const [editingLocal, setEditingLocal] = useState<StdioConnection | 'new' | null>(null)
    const [localTools, setLocalTools] = useState<Record<string, string[]>>({})
    const [servers,setServers] = useState<RemoteServer[]>([]), [editing,setEditing] = useState<RemoteServer | 'new' | null>(null)
    const [error,setError] = useState(''), [busy,setBusy] = useState(false), [tools,setTools] = useState<Record<string,string[]>>({})
    const url = `/api/desktop/coworkers/${encodeURIComponent(agentId)}/mcp`
    const request = useCallback(async (method:string,body?:unknown) => {
        const response = await fetch(url,{method,headers:body ? {'Content-Type':'application/json'} : {},body:body ? JSON.stringify(body) : undefined,cache:'no-store'})
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? 'MCP request failed')
        return data
    },[url])
    const localRequest = useCallback(async (method: string, body?: unknown) => {
        const response = await fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/mcp-stdio`, { method, headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined, cache:'no-store' })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? 'Local MCP request failed')
        return data
    }, [agentId])
    useEffect(() => { const epoch=++localListEpoch.current; const current=()=>alive.current&&epoch===localListEpoch.current; void localRequest('GET').then(data => { if (current()) setLocalServers(data) }).catch(() => { if (current()) setError('Could not load local MCP programs') }); return () => { localListEpoch.current++ } }, [localRequest])
    function openLocal(next: StdioConnection | 'new' | null) { editorEpoch.current++; actionEpoch.current++; setBusy(false); setEditing(null); setEditingLocal(next) }
    async function mutateLocal(method: string, input: unknown) {
        const epoch = editorEpoch.current
        localListEpoch.current++
        const data = await localRequest(method, input)
        if (!alive.current || epoch !== editorEpoch.current) return
        setLocalServers(data); setLocalTools({}); setError(''); openLocal(null)
    }
    async function localAction(server: StdioConnection, action: 'probe' | 'disconnect') {
        const epoch = ++actionEpoch.current, editor = editorEpoch.current
        const current = () => alive.current && epoch === actionEpoch.current && editor === editorEpoch.current
        setBusy(true); setError('')
        try { const result = await localRequest('POST', {name:server.name,revision:server.revision,action}); if(current())setLocalTools(previous => ({...previous,[server.name]:result.tools?.map((tool:{name:string})=>tool.name)??[]})) }
        catch { if(current())setError('Local MCP operation failed. Check its separate permission and installed program.') }
        finally { if(current())setBusy(false) }
    }
    useEffect(()=> { const epoch=++listEpoch.current; const current=()=>alive.current && epoch===listEpoch.current; setEditing(null); setServers([]); setTools({}); request('GET').then(data=>{if(current())setServers(data)}).catch(()=>{if(current())setError('Could not load MCP servers')}); return ()=>{listEpoch.current++} },[request])
    async function action(server:RemoteServer,action:string) {
        const generation=++actionEpoch.current, editor=editorEpoch.current
        const current=()=>alive.current && generation===actionEpoch.current && editor===editorEpoch.current && servers.some(s=>s.name===server.name && s.revision===server.revision)
        setBusy(true); setError('')
        try { const data = await request('POST',{...server,action}); if (!current()) return; setTools(prev=>({...prev,[server.name]:data.tools?.map((t:{name:string})=>t.name) ?? []})) }
        catch {if(current())setError('MCP operation failed; check configuration and coworker permission')}
        finally {if(current())setBusy(false)}
    }
    return <PanelSteps stepKey={editing || editingLocal ? 'editor' : 'list'} depth={editing || editingLocal ? 1 : 0}>
        {editingLocal ? <DesktopMcpStdioConnection key={editingLocal === 'new' ? 'local-new' : `${agentId}/${editingLocal.name}/${editingLocal.revision}`} server={editingLocal === 'new' ? undefined : editingLocal} onBack={()=>openLocal(null)} onSave={input=>mutateLocal('PUT',input)} onDelete={editingLocal === 'new' ? undefined : ()=>mutateLocal('DELETE',{name:editingLocal.name,revision:editingLocal.revision})}/> : editing ? <DesktopMcpServerEditor key={editing === 'new' ? 'new' : editing.name} server={editing === 'new' ? undefined : editing} onBack={()=>navigate(null)}
            onSave={input=>mutate('PUT',input)}
            onDelete={editing === 'new' ? undefined : ()=>mutate('DELETE',editing)} /> :
        <div className="flex flex-col h-full"><PanelListHeader count={servers.length + localServers.length} noun="MCP server"><Button size="sm" variant="outline" onClick={()=>navigate('new')}><PlusIcon className="size-3.5 mr-1"/>New HTTPS server</Button><Button size="sm" variant="outline" onClick={()=>openLocal('new')}>New local program</Button></PanelListHeader>
        {error && <p role="alert" className="p-3 text-xs text-destructive">{error}</p>}
        {!servers.length && !localServers.length ? <EmptyState icon={PlugIcon} title="No MCP servers yet" description="Add an HTTPS server or a local program to extend this coworker's tools."/> :
        <PanelScroller>{servers.map(server=><div key={server.name} className="p-3 border-b border-border space-y-2"><Button variant="ghost" onClick={()=>navigate(server)}>{server.name}</Button><p className="text-xs text-muted-foreground break-all">http · {server.url}</p><div className="flex gap-2"><Button size="sm" disabled={busy} onClick={()=>action(server,'probe')}>Connect / probe</Button><Button size="sm" variant="outline" disabled={busy} onClick={()=>action(server,'disconnect')}>Disconnect</Button></div>
        {server.hasBearer?<p className="text-xs text-muted-foreground">Bearer credential configured.</p>:<DesktopMcpOAuthAuthorize agentId={agentId} name={server.name} revision={server.revision}/>}
        {tools[server.name] && <p className="text-xs">{tools[server.name].length} tools: {tools[server.name].join(', ')}</p>}</div>)}{localServers.map(server=><div key={`local-${server.name}`} className="p-3 border-b border-border space-y-2"><Button variant="ghost" onClick={()=>openLocal(server)}>{server.name}</Button><p className="text-xs text-muted-foreground break-all">stdio · {JSON.stringify([server.executable,...server.args])}</p><div className="flex gap-2"><Button size="sm" disabled={busy} onClick={()=>localAction(server,'probe')}>Connect / probe local program</Button><Button size="sm" variant="outline" disabled={busy} onClick={()=>localAction(server,'disconnect')}>Disconnect local program</Button></div>{localTools[server.name] && <p className="text-xs">{localTools[server.name].length} tools: {localTools[server.name].join(', ')}</p>}</div>)}</PanelScroller>}
        <p className="p-3 text-xs text-muted-foreground">Remote servers and local programs have separate permissions in Tools. Local programs run as your Mac user and can access Mac files and the network. Probe results describe one completed connection.</p></div>}
    </PanelSteps>
}
export function DesktopMcpServerEditor({server,onSave,onDelete,onBack}:{server?:RemoteServer;onSave:(input:{name:string;url:string;revision?:string;bearer?:string})=>Promise<void>;onDelete?:()=>Promise<void>;onBack:()=>void}) {
    const [name,setName]=useState(server?.name ?? ''),[url,setUrl]=useState(server?.url ?? ''),[bearer,setBearer]=useState('')
    const [replace,setReplace]=useState(!server?.hasBearer),[busy,setBusy]=useState(false),[error,setError]=useState('')
    const pending=useRef(false), mounted=useRef(true)
    // Unmount drops the editor's local credential state; it is never lifted into panel/config state.
    useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false}},[])
    async function perform(fn:()=>Promise<void>) {
        if(pending.current)return
        pending.current=true;setBusy(true);setError('')
        try {await fn();if(mounted.current)setBearer('')}
        catch {if(mounted.current)setError('MCP configuration could not be saved; reload and try again')}
        finally {pending.current=false;if(mounted.current)setBusy(false)}
    }
    function back() {if(!pending.current){setBearer('');onBack()}}
    return <PanelEditorShell><PanelEditorHeader title={server ? 'Edit MCP server' : 'New MCP server'} onBack={busy ? undefined : back}/><PanelEditorBody>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Field label="Name" htmlFor="desktop-mcp-name" helperText={`Tools are merged as "${name || 'name'}_<tool>".`}><Input id="desktop-mcp-name" disabled={!!server || busy} value={name} onChange={e=>setName(e.target.value)}/></Field>
        <p className="text-xs">Streamable HTTP · HTTPS</p><Field label="URL" htmlFor="desktop-mcp-url"><Input id="desktop-mcp-url" value={url} onChange={e=>setUrl(e.target.value)} disabled={busy}/></Field>
        <label className="text-xs"><input type="checkbox" disabled={busy} checked={replace} onChange={e=>setReplace(e.target.checked)}/> Replace bearer (empty means anonymous)</label>
        {replace && <Field label="Bearer credential" htmlFor="desktop-mcp-bearer"><Input id="desktop-mcp-bearer" type="password" autoComplete="off" value={bearer} onChange={e=>setBearer(e.target.value)} disabled={busy}/></Field>}
        </PanelEditorBody><PanelEditorFooter><Button disabled={busy || !name || !url} onClick={()=>perform(()=>onSave({name,url,revision:server?.revision,...(replace ? {bearer} : {})}))}>Save</Button>
        {onDelete && <PanelDeleteButton label="Delete MCP server" disabled={busy} busy={busy} onClick={()=>perform(onDelete)}/>}</PanelEditorFooter></PanelEditorShell>
}
