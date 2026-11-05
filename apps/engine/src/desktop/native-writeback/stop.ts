import {spawnSync,type ChildProcessWithoutNullStreams} from 'node:child_process'
const stoppedWriters=new WeakMap<ChildProcessWithoutNullStreams,number[]>()

/** The exec server can own a PTY child in a different process group. Freeze the
 * server before enumerating children, then confirm every captured process exits.
 * Seatbelt forbids commands forking further descendants. An already exited server
 * cannot establish this evidence and must not yield a writeback capture. */
export async function stopNativeProcess(child:ChildProcessWithoutNullStreams):Promise<void>{
 const pid=child.pid
 if(!pid)return // Node leaves pid undefined when no process was spawned.
 const previous=stoppedWriters.get(child)
 if(!previous && (child.exitCode!==null || child.signalCode!==null))throw new Error('Native worker exited before its writers could be confirmed stopped')
 let descendants:number[]=[]
 let enumerationFailed=false
 if(!previous){
 try{
  process.kill(pid,'SIGSTOP')
  const listed=spawnSync('/usr/bin/pgrep',['-P',String(pid)],{encoding:'utf8',timeout:1500,maxBuffer:4096})
  if(listed.error || listed.status!==0 && listed.status!==1)enumerationFailed=true
  else if(listed.status===0){
   const names=listed.stdout.trim().split(/\s+/)
   if(!names.length || names.some(value=>!/^\d+$/.test(value) || Number(value)<=1))enumerationFailed=true
   else descendants=names.map(Number)
  }
 }catch{enumerationFailed=true}
 for(const id of descendants)try{process.kill(id,'SIGKILL')}catch{}
 try{process.kill(-pid,'SIGKILL')}catch{try{child.kill('SIGKILL')}catch{}}
 if(enumerationFailed)throw new Error('Native writer enumeration was not confirmed; scratch retained')
 stoppedWriters.set(child,[pid,-pid,...descendants])
 }
 // A retry only observes PIDs already sent SIGKILL. Never kill a possibly reused
 // PID after a delayed user retry; retain uncertainty if it is still present.
 const observed=previous??stoppedWriters.get(child)!
 const alive=(id:number)=>{try{process.kill(id,0);return true}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw new Error('Native writer exit was not confirmed; scratch retained')}}
 for(let attempt=0;attempt<60;attempt++){
  if(!observed.some(alive))return
  await new Promise<void>(resolve=>setTimeout(resolve,50))
 }
 throw new Error('Native writers have not stopped; scratch retained')
}
