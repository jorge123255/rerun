import { CameraView, useCameraPermissions } from 'expo-camera'
import { useEffect, useRef, useState } from 'react'
import { TextInput, View } from 'react-native'
import { useTranslations } from 'use-intl'

import { FIELD_HEIGHT, FIELD_RADIUS } from '@/components/auth/PhoneField'
import { useSignInFlow } from '@/components/auth/SignInFlow'
import { StepTitle } from '@/components/auth/steps/StepTitle'
import { TextLink } from '@/components/auth/TextLink'
import { AppText } from '@/components/ui/AppText'
import { Button } from '@/components/ui/Button'
import { macClient } from '@/mac/client'
import { pairWithMac, readMacOffer, type MacPairingProblem } from '@/mac/connect'
import { restartOnMac } from '@/mac/session'
import { fieldOutline } from '@/theme/field'
import { useTheme } from '@/theme/theme'
import { fonts, radius, spacing } from '@/theme/tokens'

type Stage = 'code' | 'scanning' | 'connecting' | 'waiting'

// Pairing with the Mac app: the phone hands over the code the Mac shows, the person approves the phone
// on the Mac, and the app starts again on the Mac. No account is involved.
export function MacStep() {
    const theme = useTheme()
    const t = useTranslations('mobileAuth.mac')
    const { setThinking } = useSignInFlow()
    const [code, setCode] = useState('')
    const [focused, setFocused] = useState(false)
    const [stage, setStage] = useState<Stage>('code')
    const [problem, setProblem] = useState<MacPairingProblem | null>(null)
    const [permission, requestPermission] = useCameraPermissions()
    const attempt = useRef<AbortController | null>(null)

    // Leaving the step lets go of a request the Mac has not approved yet.
    useEffect(
        () => () => {
            attempt.current?.abort()
            setThinking(false)
        },
        [setThinking]
    )

    const connect = async (input: string) => {
        const offer = readMacOffer(macClient, input)
        if (!offer.ok) {
            setStage('code')
            return setProblem(offer.problem)
        }
        attempt.current?.abort()
        const controller = new AbortController()
        attempt.current = controller
        setProblem(null)
        setStage('connecting')
        setThinking(true)
        const result = await pairWithMac(macClient, offer, { signal: controller.signal, onWaiting: () => setStage('waiting') })
        if (result.ok) return restartOnMac()
        if (attempt.current !== controller) return
        setThinking(false)
        setStage('code')
        if (result.problem !== 'cancelled') setProblem(result.problem)
    }

    const scan = async () => {
        setProblem(null)
        const granted = permission?.granted || (await requestPermission()).granted
        setStage(granted ? 'scanning' : 'code')
    }

    const cancel = () => {
        attempt.current?.abort()
        attempt.current = null
        setThinking(false)
        setStage('code')
    }

    if (stage === 'waiting') {
        return (
            <>
                <StepTitle title={t('waiting')} subtitle={t('waitingHint')} />
                <View style={{ alignItems: 'center' }}>
                    <TextLink label={t('cancel')} onPress={cancel} />
                </View>
            </>
        )
    }

    return (
        <>
            <StepTitle title={t('title')} subtitle={t('hint')} />
            {stage === 'scanning' ? (
                <>
                    <View style={{ height: 260, borderRadius: radius.lg, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: theme.muted }}>
                        <CameraView
                            testID="mac-scanner"
                            style={{ flex: 1 }}
                            facing="back"
                            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                            onBarcodeScanned={({ data }) => {
                                setStage('connecting')
                                void connect(data)
                            }}
                        />
                    </View>
                    <View style={{ alignItems: 'center' }}>
                        <TextLink label={t('typeInstead')} onPress={() => setStage('code')} />
                    </View>
                </>
            ) : (
                <>
                    <Button label={t('scan')} variant="outline" size="lg" symbol="camera" disabled={stage === 'connecting'} onPress={scan} />
                    {permission && !permission.granted && !permission.canAskAgain && (
                        <AppText variant="footnote" tone="muted">
                            {t('cameraDenied')}
                        </AppText>
                    )}
                    <TextInput
                        testID="mac-code"
                        value={code}
                        onChangeText={text => {
                            setCode(text)
                            setProblem(null)
                        }}
                        placeholder={t('code')}
                        placeholderTextColor={theme.mutedForeground}
                        autoCapitalize="none"
                        autoCorrect={false}
                        spellCheck={false}
                        // The code is long, so it wraps; return still sends it, as on the other steps.
                        multiline
                        submitBehavior="blurAndSubmit"
                        returnKeyType="go"
                        onSubmitEditing={() => connect(code)}
                        accessibilityLabel={t('code')}
                        onFocus={() => setFocused(true)}
                        onBlur={() => setFocused(false)}
                        maxFontSizeMultiplier={1.3}
                        style={{ minHeight: FIELD_HEIGHT, maxHeight: 88, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: FIELD_RADIUS, borderCurve: 'continuous', ...fieldOutline(theme, { focused, invalid: !!problem }), backgroundColor: theme.card, fontFamily: fonts.regular, fontSize: 15, color: theme.foreground }}
                    />
                    {problem && (
                        <AppText variant="footnote" tone="destructive">
                            {t(`problems.${problem}`)}
                        </AppText>
                    )}
                    <Button label={t('connect')} size="lg" loading={stage === 'connecting'} disabled={!code.trim()} onPress={() => connect(code)} />
                </>
            )}
        </>
    )
}
