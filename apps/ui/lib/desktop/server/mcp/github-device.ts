import 'server-only'
import {deviceGrant,oauthDeviceForm,oauthHttps,OAuthFailure,OAuthTransportError,type OAuthDeviceForm} from './oauth-network'
import type {OAuthTokenBundle} from './store'

/**
 * "Sign in with GitHub" on the Mac, the way the GitHub CLI signs in: GitHub's device flow with the
 * client ID of an OAuth App, and no client secret. GitHub's sign-in service publishes neither
 * dynamic client registration nor public-client token authentication, so the loopback flow every
 * other provider uses can never complete for it (checked against GitHub's public discovery
 * documents on 2026-11-18).
 *
 * Only the two GitHub endpoints below are contacted, over HTTPS, through the same pinned public
 * address checks as every other sign-in request. The device code and the token stay in the server
 * process; the renderer is given the user code and GitHub's verification page, nothing else.
 */
export const GITHUB_MCP_ORIGIN='https://api.githubcopilot.com'
export const GITHUB_ISSUER='https://github.com/login/oauth'
export const GITHUB_DEVICE_CODE_URL='https://github.com/login/device/code'
export const GITHUB_TOKEN_URL='https://github.com/login/oauth/access_token'
const GITHUB_ORIGIN='https://github.com'

/**
 * GitHub's MCP server lists these scopes in its resource metadata: repo, read:org, read:user,
 * user:email, read:packages, write:packages, read:project, project, gist, notifications.
 * Reading and working on repositories, issues and pull requests needs `repo` (GitHub has no
 * narrower OAuth App scope that covers private repositories, their issues and their pull
 * requests) and `read:org` (organization membership and team lookups the server uses to list and
 * filter an organization's repositories). Packages, projects, gists, notifications and email are
 * left out; the person can switch to a fine-grained token for anything narrower or wider.
 */
export const GITHUB_MCP_SCOPES=['repo','read:org'] as const

/** The OAuth App's public client ID, baked into the staged build. Without one, GitHub sign-in is not offered. */
export function githubDeviceClientId(value:string|undefined=process.env.RERUN_DESKTOP_GITHUB_CLIENT_ID):string|null {
 return typeof value==='string' && /^[A-Za-z0-9._-]{8,64}$/.test(value) ? value : null
}

export function isGitHubMcpResource(url:string) {
 try{return new URL(url).origin===GITHUB_MCP_ORIGIN}catch{return false}
}

export const GITHUB_SIGN_IN_UNAVAILABLE='GitHub does not let apps register themselves for sign-in, and this copy of Rerun has no GitHub sign-in app set up. Use a GitHub Personal Access Token instead.'
const unreachable='Rerun could not reach GitHub. Check the internet connection and retry.'
const unreadable='GitHub’s answer could not be read. Retry in a moment.'
const disabled='The GitHub sign-in app of this copy of Rerun does not have Device Flow turned on.'
const unknownApp='GitHub does not recognise the sign-in app of this copy of Rerun.'
const expired='The code expired before it was entered on GitHub. Start again.'

export type GitHubDeviceCode={deviceCode:string;userCode:string;verificationUri:string;expiresIn:number;interval:number}
export type GitHubDevicePoll={kind:'pending'}|{kind:'slow-down';interval:number}|{kind:'unreachable'}|{kind:'token';bundle:Omit<OAuthTokenBundle,'resource'>}

function transport(error:unknown,refused:string):never {
 if(error instanceof OAuthFailure)throw error
 if(error instanceof OAuthTransportError)throw new OAuthFailure(error.kind==='refused'?refused:error.kind==='invalid'?unreadable:unreachable,'error')
 throw new OAuthFailure(unreachable,'error')
}

function deviceError(code:unknown):OAuthFailure {
 switch(code){
  case 'expired_token':return new OAuthFailure(expired,'error')
  case 'access_denied':return new OAuthFailure('Sign-in was declined on GitHub.','error')
  case 'device_flow_disabled':return new OAuthFailure(disabled,'unsupported')
  case 'incorrect_client_credentials':case 'unauthorized_client':case 'invalid_client':return new OAuthFailure(unknownApp,'unsupported')
  case 'invalid_scope':return new OAuthFailure('GitHub refused the permissions Rerun asks for.','error')
  default:return new OAuthFailure('GitHub did not accept the sign-in request. Start again.','error')
 }
}

/** Asks GitHub for a code the person types on GitHub's page. */
export async function requestGitHubDeviceCode(clientId:string,signal:AbortSignal,form:OAuthDeviceForm=oauthDeviceForm):Promise<GitHubDeviceCode> {
 let body:Record<string,unknown>
 try{({body}=await form(GITHUB_DEVICE_CODE_URL,signal,new URLSearchParams({client_id:clientId,scope:GITHUB_MCP_SCOPES.join(' ')}),true))}
 catch(error){signal.throwIfAborted();transport(error,'GitHub refused to start sign-in for this copy of Rerun.')}
 if(body.error!==undefined)throw deviceError(body.error)
 const {device_code:deviceCode,user_code:userCode,verification_uri:page,expires_in:expiresIn,interval=5}=body
 if(typeof deviceCode!=='string' || !/^[\x21-\x7e]{1,512}$/.test(deviceCode) || typeof userCode!=='string' || !/^[A-Za-z0-9-]{4,32}$/.test(userCode)
  || typeof page!=='string' || typeof expiresIn!=='number' || !Number.isFinite(expiresIn) || expiresIn<=0 || expiresIn>3600
  || typeof interval!=='number' || !Number.isFinite(interval) || interval<0 || interval>60)throw new OAuthFailure(unreadable,'error')
 let verificationUri:string
 try{const url=oauthHttps(page);if(url.origin!==GITHUB_ORIGIN || url.search || url.hash)throw new Error();verificationUri=url.href}
 catch{throw new OAuthFailure('GitHub sent a sign-in page outside github.com. Sign-in was stopped.','error')}
 return {deviceCode,userCode,verificationUri,expiresIn,interval:Math.max(1,Math.ceil(interval))}
}

/** One poll of GitHub's token endpoint. GitHub answers pending and refusals as JSON, with status 200 or 400. */
export async function pollGitHubDeviceToken(clientId:string,deviceCode:string,interval:number,signal:AbortSignal,form:OAuthDeviceForm=oauthDeviceForm,now=Date.now):Promise<GitHubDevicePoll> {
 let body:Record<string,unknown>
 try{({body}=await form(GITHUB_TOKEN_URL,signal,new URLSearchParams({client_id:clientId,device_code:deviceCode,grant_type:deviceGrant}),true))}
 catch(error){
  signal.throwIfAborted()
  // A dropped connection is retried at the next interval; a refusal or an unreadable answer is not.
  if(error instanceof OAuthTransportError && error.kind==='unreachable')return {kind:'unreachable'}
  transport(error,'GitHub refused the sign-in request.')
 }
 if(body.error==='authorization_pending')return {kind:'pending'}
 if(body.error==='slow_down'){
  const asked=typeof body.interval==='number' && Number.isFinite(body.interval) ? body.interval : 0
  return {kind:'slow-down',interval:Math.min(60,Math.max(interval+5,Math.ceil(asked)))}
 }
 if(body.error!==undefined)throw deviceError(body.error)
 return {kind:'token',bundle:githubTokenBundle(body,clientId,now)}
}

const unusable='The token GitHub returned is not usable.'
/**
 * A GitHub OAuth App token has no expiry and no refresh token. A token from an app with expiring
 * tokens is kept until it expires; its refresh token is dropped, because refreshing needs the
 * client secret a desktop app cannot keep. Either way the person signs in again when it ends.
 */
export function githubTokenBundle(data:Record<string,unknown>,clientId:string,now=Date.now):Omit<OAuthTokenBundle,'resource'> {
 if(typeof data.token_type!=='string' || data.token_type.toLowerCase()!=='bearer')throw new OAuthFailure(unusable,'error')
 if(typeof data.access_token!=='string' || !/^[\x21-\x7e]{1,8192}$/.test(data.access_token))throw new OAuthFailure(unusable,'error')
 if(data.scope!==undefined && (typeof data.scope!=='string' || data.scope.length>8192))throw new OAuthFailure(unusable,'error')
 const expires=data.expires_in
 if(expires!==undefined && (typeof expires!=='number' || !Number.isFinite(expires) || expires<=0 || expires>365*86400))throw new OAuthFailure(unusable,'error')
 return {
  accessToken:data.access_token,issuer:GITHUB_ISSUER,tokenEndpoint:GITHUB_TOKEN_URL,clientId,signIn:'github-device',
  ...(typeof data.scope==='string'?{scope:data.scope}:{}),
  ...(typeof expires==='number'?{expiresAt:now()+expires*1000}:{expiresAt:OAUTH_NO_EXPIRY,neverExpires:true as const}),
 }
}

/** Stands in for an expiry on a token that has none, so every "has it expired" comparison still holds. */
export const OAUTH_NO_EXPIRY=Number.MAX_SAFE_INTEGER

export type SignInPlan={kind:'loopback'}|{kind:'github-device';clientId:string;form:OAuthDeviceForm;sleep:(ms:number,signal:AbortSignal)=>Promise<void>}|{kind:'unavailable';message:string}

export function abortableSleep(ms:number,signal:AbortSignal) {
 return new Promise<void>((resolve,reject)=>{
  if(signal.aborted){reject(signal.reason);return}
  const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve()},ms)
  const stop=()=>{clearTimeout(timer);reject(signal.reason)}
  signal.addEventListener('abort',stop,{once:true})
 })
}

/**
 * Which sign-in a Vault MCP address gets. GitHub's MCP server gets the device flow when this build
 * carries a client ID, and a plain reason when it does not; every other address keeps the loopback flow.
 */
export function vaultSignInPlan(clientId:string|null=githubDeviceClientId(),form:OAuthDeviceForm=oauthDeviceForm,sleep=abortableSleep) {
 return (url:string):SignInPlan=>{
  if(!isGitHubMcpResource(url))return {kind:'loopback'}
  return clientId?{kind:'github-device',clientId,form,sleep}:{kind:'unavailable',message:GITHUB_SIGN_IN_UNAVAILABLE}
 }
}
