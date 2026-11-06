'use client'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopToolInstallSnapshot } from '@rerun/contracts'
import { createDesktopToolInstallClient, type DesktopToolInstallClient } from '@/lib/desktop/tool-install-client'

export function useDesktopToolInstall(sessionId: string, operationId: string, active = true) {
 const [snapshot, setSnapshot] = useState<DesktopToolInstallSnapshot | null>(null)
 const [loading, setLoading] = useState(true), [error, setError] = useState('')
 const [action, setAction] = useState<'decision' | 'inspect' | null>(null)
 const owner = useRef<{ sessionId: string; operationId: string; client: DesktopToolInstallClient; alive: boolean; busy: boolean; read: number } | null>(null)
 const refresh = useCallback(async () => {
  const current = owner.current
  if (!current?.alive || current.sessionId !== sessionId || current.operationId !== operationId) return
  const read = ++current.read; setLoading(true)
  try { const result = await current.client.read(operationId); if (owner.current === current && current.alive && read === current.read) { setSnapshot(result); setError('') } }
  catch (cause) { if (owner.current === current && current.alive && read === current.read) setError(cause instanceof Error ? cause.message : 'Could not read installation.') }
  finally { if (owner.current === current && current.alive && read === current.read) setLoading(false) }
 }, [sessionId, operationId])
 useEffect(() => {
  setSnapshot(null); setError(''); setAction(null); setLoading(active)
  if (!active) return
  const current = { sessionId, operationId, client: createDesktopToolInstallClient(sessionId), alive: true, busy: false, read: 0 }
  owner.current = current; void refresh()
  return () => { current.alive = false; current.client.dispose(); if (owner.current === current) owner.current = null }
 }, [active, sessionId, operationId, refresh])
 useEffect(() => {
  if (!active || snapshot?.status !== 'installing') return
  const timer = setInterval(() => void refresh(), 3000)
  return () => clearInterval(timer)
 }, [active, refresh, snapshot?.status])
 const mutate = useCallback(async (kind: 'decision' | 'inspect', decision?: 'approved' | 'declined', note?: string) => {
  const current = owner.current
  if (isDesktopQuitting() || !active || !snapshot || !current?.alive || current.busy || current.sessionId !== sessionId || current.operationId !== operationId || snapshot.operationId !== operationId) return
  current.busy = true; ++current.read; setAction(kind); setError('')
  try {
   const result = kind === 'decision' ? await current.client.decide(snapshot, decision!, note) : await current.client.inspect(snapshot)
   if (owner.current === current && current.alive) setSnapshot(result)
  } catch (cause) {
   if (owner.current === current && current.alive) { setError(cause instanceof Error ? cause.message : 'The installation result could not be confirmed.'); await refresh() }
  } finally { current.busy = false; if (owner.current === current && current.alive) setAction(null) }
 }, [active, snapshot, sessionId, operationId, refresh])
 return { snapshot, loading, error, action, refresh, decide: (decision: 'approved' | 'declined', note?: string) => mutate('decision', decision, note), inspect: () => mutate('inspect') }
}
