import type {DesktopServiceAccountIntent} from '../../../../../../../packages/contracts/src/desktop-service-accounts'
import type {DesktopServiceOAuthSnapshot as Snapshot} from '../../../../../../../packages/contracts/src/desktop-service-oauth'
import type {ServiceManifest} from '@/lib/services/manifest'
import type {CatalogOAuthPlan} from './compiler'
import type {OAuthTokenBundle} from '../../mcp/store'
export type OAuthAccountBinding={owner:string;engineId:string;installationId:string;accountKey:string;label:string;methodId:string;configGeneration:string;endpoint:string;transport:'http';catalogFingerprint:string;serverName:string}
export type OAuthAttempt={version:1;requestId:string;fingerprint:string;binding:OAuthAccountBinding;snapshot:Snapshot;probePending:boolean}
export interface OAuthAccounts {
 catalog(slug:string):Promise<ServiceManifest|null>;
 configure(owner:string,requestId:string,intent:DesktopServiceAccountIntent,plan:CatalogOAuthPlan,signal:AbortSignal):Promise<OAuthAccountBinding>;
 current(owner:string,accountKey:string,signal:AbortSignal):Promise<{binding:OAuthAccountBinding;enabled:boolean;granted:boolean;healthy:boolean}>;
 // Share the EXISTING account/owner mutation gate, including old APIs and removal.
 exclusive<T>(owner:string,installationId:string,work:()=>Promise<T>):Promise<T>;
 readiness(binding:OAuthAccountBinding,credential:()=>Promise<string>,signal:AbortSignal):Promise<{healthy:boolean}>;
 disconnect(binding:OAuthAccountBinding,signal:AbortSignal):Promise<void>;
}
export interface OAuthAttemptStore {
 reserve(attempt:OAuthAttempt):Promise<{created:boolean;attempt:OAuthAttempt}>;
 read(owner:string,attemptId:string):Promise<OAuthAttempt|null>;
 list(owner?:string):Promise<OAuthAttempt[]>;
 save(attempt:OAuthAttempt,expectedRevision:string):Promise<void>;
 readToken(attempt:OAuthAttempt):Promise<OAuthTokenBundle|null>;
 writeToken(attempt:OAuthAttempt,bundle:OAuthTokenBundle,signal:AbortSignal):Promise<void>;
 clearToken(attempt:OAuthAttempt):Promise<void>;
}
export type OAuthPrimitive={
 start(signal:AbortSignal):Promise<{status:{state:string};authorizationUrl?:string}>;
 status(signal:AbortSignal):Promise<{state:string}>;
 credential(signal:AbortSignal):Promise<string|null>;
 cancel(signal:AbortSignal):Promise<void>;
 shutdown():void;
}
export type OAuthPrimitiveFactory=(attempt:OAuthAttempt,guard:(signal:AbortSignal)=>Promise<void>)=>OAuthPrimitive
export type ApprovedOAuthBrowser=(url:string,signal:AbortSignal)=>Promise<void>
