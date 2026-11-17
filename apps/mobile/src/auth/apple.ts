import * as AppleAuthentication from 'expo-apple-authentication'

import { SignInError } from '@/auth/sign-in'
import { supabase } from '@/auth/supabase'

const FAILED = 'We could not sign you in with Apple. Try again.'

// Resolves false when the person closed the Apple sheet: nothing to show then.
export async function signInWithApple(): Promise<boolean> {
    let credential: AppleAuthentication.AppleAuthenticationCredential
    try {
        credential = await AppleAuthentication.signInAsync({ requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL] })
    } catch (error) {
        if ((error as { code?: string }).code === 'ERR_REQUEST_CANCELED') return false
        throw new SignInError(FAILED, 'apple')
    }
    if (!credential.identityToken) throw new SignInError(FAILED, 'apple')

    const { error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken })
    if (error) throw new SignInError(FAILED, 'apple')

    // Apple hands the name over on the very first sign-in only, and leaves it out of the token: kept
    // where the web reads it, or the account would never have one.
    const fullName = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ')
    if (fullName) await supabase.auth.updateUser({ data: { full_name: fullName } })
    return true
}
