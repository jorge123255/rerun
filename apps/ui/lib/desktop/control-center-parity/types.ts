import type {ControlCommandId} from '@/lib/control-center/commands'
import type {ControlRow,ControlSection} from '@/components/control-center/types'
import type {DesktopCoworkerPanel} from '@/lib/desktop/coworker-panel'
import type {DesktopOpenChat} from '@/lib/desktop/control-center-chats'
import type {DesktopConversationHit} from '@/lib/desktop/chat-search'
import type {DesktopForemanChatRef} from '@/lib/desktop/foreman-client/identity'
export type ParityTarget=
 | {kind:'workspace';workspaceId:string;revision:string}
 | {kind:'coworker';workspaceId:string;agentId:string;revision:string}
 | {kind:'box';workspaceId:string;spaceId:string;revision:string}
 | {kind:'chat';workspaceId:string;agentId:string;sessionId:string|null;tabUid:string|null;revision:string}
export type ParityPage={kind:'root'}|{kind:'coworker';agentId:string}|{kind:'box';spaceId:string}|{kind:'move';agentId:string}
export type ParityCapability={state:'ready'|'unavailable'|'omit';reason?:string}
export type ParitySnapshot={
 workspace:{id:string;revision:string};quitting:boolean;blocked:boolean;
 coworkers:{id:string;revision:string;name:string;enabled:boolean;spaceId:string|null;pending:boolean}[];
 boxes:{id:string;revision:string;name:string}[];
 // Actual persisted open tabs (including unsent) and saved chat identities, never guessed sessions.
 chats:{agentId:string;sessionId:string|null;tabUid:string|null;revision:string;title:string;open:boolean}[];
 foreman:DesktopForemanChatRef|null;
}
export type ParityIntent=
 | {kind:'global';command:ControlCommandId;target:Extract<ParityTarget,{kind:'workspace'}>}
 | {kind:'panel';panel:DesktopCoworkerPanel;target:Extract<ParityTarget,{kind:'coworker'}>}
 | {kind:'desktop';target:Extract<ParityTarget,{kind:'coworker'}>}
 | {kind:'notifications';target:Extract<ParityTarget,{kind:'coworker'}>}
 | {kind:'move';target:Extract<ParityTarget,{kind:'coworker'}>;destination:Extract<ParityTarget,{kind:'box'}>;sourceSpaceId:string|null}
 | {kind:'chat';target:Extract<ParityTarget,{kind:'chat'}>}
 | {kind:'assistant';target:Extract<ParityTarget,{kind:'workspace'}>;chat:DesktopForemanChatRef;draft:string}
export type ParityCommand={key:string;label:string;description?:string;keywords?:string[];icon:ControlRow['leading'];group:'actions'|'settings'|'open'|'conversations';intent:ParityIntent;disabledReason?:string;omitted?:boolean}
export interface ParityActions {
 read(signal:AbortSignal):Promise<ParitySnapshot>;
 capability(intent:ParityIntent,snapshot:ParitySnapshot):ParityCapability;
 // Canonical action takes the exact checked target; it must not fall back to current selection.
 dispatch(intent:ParityIntent,signal:AbortSignal):Promise<void>;
}
export type ParityExecution={signal:AbortSignal;workspaceId:string;expectedRevision:string}
export type ParityNavigationBindings={
 global:Partial<Record<string,(workspaceId:string,execution:ParityExecution)=>void|Promise<void>>>;
 panel?:(agentId:string,panel:DesktopCoworkerPanel,execution:ParityExecution)=>void|Promise<void>;
 desktop?:(agentId:string,execution:ParityExecution)=>void|Promise<void>;
 notifications?:(agentId:string,execution:ParityExecution)=>void|Promise<void>;
 move?:(agentId:string,spaceId:string,execution:ParityExecution)=>void|Promise<void>;
 openTab?:(chat:DesktopOpenChat,execution:ParityExecution)=>void|Promise<void>;
 openSaved?:(chat:DesktopConversationHit,execution:ParityExecution)=>void|Promise<void>;
 // Empty draft toggles the existing Foreman; a nonempty explicit Ask dispatch uses its canonical send path.
 assistant?:(chat:DesktopForemanChatRef,draft:string,execution:ParityExecution)=>void|Promise<void>;
}
export type ParitySections=ControlSection[]
