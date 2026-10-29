/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { useAccessor, useIsDark, useSettingsState } from '../util/services.js';
import { OneClickSwitchButton } from '../zero-egress-settings-tsx/Settings.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { ConnectModelStep, useConnectModel } from './ConnectModelStep.js';

const OVERRIDE_VALUE = false

export const ZeroEgressOnboarding = () => {

	const zeroEgressSettingsState = useSettingsState()
	const isOnboardingComplete = zeroEgressSettingsState.globalSettings.isOnboardingComplete || OVERRIDE_VALUE

	const isDark = useIsDark()

	return (
		<div className={`@@ze-scope ${isDark ? 'dark' : ''}`}>
			<div
				className={`
					bg-ze-bg-3 fixed top-0 right-0 bottom-0 left-0 width-full z-[99999]
					transition-all duration-1000 ${isOnboardingComplete ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'}
				`}
				style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
			>
				<ErrorBoundary>
					<ZeroEgressOnboardingContent />
				</ErrorBoundary>
			</div>
		</div>
	)
}

// The splash mark and wordmark are drawn inline (no raster, no card) so they sit
// directly on the editor background in every theme. Mark geometry is the bare
// mark from resources/zero-egress/logo.svg (crop box 12 22 72 64); keep in sync.
const ZE_MINT = '#34d399'
const ZeroEgressWordmark = () => {
	// Faded arcs: .3 as in logo.svg on dark themes; a touch stronger on light
	// themes, where mint at .3 almost disappears into white.
	const arcOpacity = useIsDark() ? '.3' : '.5'
	return (
		<div className='flex flex-col items-center gap-5 select-none' role='img' aria-label='ZeroEgress'>
			<svg viewBox='12 22 72 64' width='128' height='114' aria-hidden='true'>
				<path d='M16 40 a44 44 0 0 1 64 0' fill='none' stroke={ZE_MINT} strokeWidth='7' strokeLinecap='round' opacity={arcOpacity} />
				<path d='M28 51 a28 28 0 0 1 40 0' fill='none' stroke={ZE_MINT} strokeWidth='7' strokeLinecap='round' opacity={arcOpacity} />
				<ellipse cx='48' cy='70' rx='9' ry='12' fill='none' stroke={ZE_MINT} strokeWidth='5.5' />
				<line x1='43' y1='78' x2='53' y2='62' stroke={ZE_MINT} strokeWidth='5' strokeLinecap='round' />
			</svg>
			<div
				style={{
					color: 'var(--vscode-foreground)',
					fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
					fontSize: '56px',
					lineHeight: 1,
					letterSpacing: '-0.5px',
				}}
			>
				<span style={{ fontWeight: 700 }}>Zero</span><span style={{ fontWeight: 400 }}>Egress</span>
			</div>
		</div>
	)
}

const FADE_DURATION_MS = 2000

const FadeIn = ({ children, className, delayMs = 0, durationMs, ...props }: { children: React.ReactNode, delayMs?: number, durationMs?: number, className?: string } & React.HTMLAttributes<HTMLDivElement>) => {

	const [opacity, setOpacity] = useState(0)

	const effectiveDurationMs = durationMs ?? FADE_DURATION_MS

	useEffect(() => {

		const timeout = setTimeout(() => {
			setOpacity(1)
		}, delayMs)

		return () => clearTimeout(timeout)
	}, [setOpacity, delayMs])


	return (
		<div className={className} style={{ opacity, transition: `opacity ${effectiveDurationMs}ms ease-in-out` }} {...props}>
			{children}
		</div>
	)
}

// First run: Welcome → Connect a model → Settings and themes

const STEP_COUNT = 3

/** Three 28×4px segments; the done and active ones in the accent color. */
const StepProgress = ({ stepIndex }: { stepIndex: number }) => (
	<div className='flex gap-1.5' role='progressbar' aria-valuemin={1} aria-valuemax={STEP_COUNT} aria-valuenow={stepIndex + 1}>
		{Array.from({ length: STEP_COUNT }, (_, i) => (
			<span key={i} className={`block w-[28px] h-[4px] rounded-sm ${i <= stepIndex ? 'bg-ze-accent' : 'bg-ze-border-4'}`} />
		))}
	</div>
)

const BackButton = ({ onClick }: { onClick: () => void }) => (
	<button
		type='button'
		className='px-4 py-1.5 rounded text-sm text-ze-fg-2 border border-ze-border-2 bg-ze-bg-1 hover:bg-ze-bg-2-hover transition-colors'
		onClick={onClick}
	>
		Back
	</button>
)

const ContinueButton = ({ onClick, disabled = false, children = 'Continue' }: { onClick: () => void, disabled?: boolean, children?: React.ReactNode }) => (
	<button
		type='button'
		className={`px-4 py-1.5 rounded text-sm font-medium bg-ze-accent text-ze-on-accent transition-colors ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-ze-accent-hover'}`}
		disabled={disabled}
		onClick={onClick}
	>
		{children}
	</button>
)

const ZeroEgressOnboardingContent = () => {

	const accessor = useAccessor()
	const zeroEgressSettingsService = accessor.get('IZeroEgressSettingsService')
	const zeroEgressMetricsService = accessor.get('IMetricsService')

	const zeroEgressSettingsState = useSettingsState()
	const isOnboardingComplete = zeroEgressSettingsState.globalSettings.isOnboardingComplete

	const [stepIndex, setStepIndex] = useState(0)

	// reset to the first step if the user redoes onboarding
	useEffect(() => {
		if (!isOnboardingComplete) {
			setStepIndex(0)
		}
	}, [setStepIndex, isOnboardingComplete])

	const connectModel = useConnectModel(stepIndex === 1 && !isOnboardingComplete)

	const finish = () => {
		zeroEgressSettingsService.setGlobalSetting('isOnboardingComplete', true);
		zeroEgressMetricsService.capture('Completed Onboarding', { selectedProviderName: connectModel.selectedModel?.providerName ?? null })
	}

	const contentOfIdx: { [stepIndex: number]: React.ReactNode } = {
		0: <div className='flex flex-col items-center gap-6 text-center'>
			<ZeroEgressWordmark />
			<div className='text-3xl text-ze-fg-1'>Welcome to ZeroEgress</div>
			<div className='text-base text-ze-fg-3 max-w-[460px]'>ZeroEgress sends your code and prompts only to models you run yourself. Let's connect one.</div>
		</div>,

		1: <ConnectModelStep state={connectModel} />,

		2: <div className='flex flex-col gap-4 w-full'>
			<div className='text-2xl text-ze-fg-1'>Settings and themes</div>
			<div className='text-sm text-ze-fg-3'>Transfer your settings from an existing editor?</div>
			<div className='flex flex-col items-start gap-3'>
				<OneClickSwitchButton className='w-full px-4 py-2' fromEditor="VS Code" />
				<OneClickSwitchButton className='w-full px-4 py-2' fromEditor="Windsurf" />
			</div>
		</div>,
	}

	const onContinue = () => {
		if (stepIndex === 1) {
			if (connectModel.isLooking) { return }
			connectModel.apply()
		}
		if (stepIndex === STEP_COUNT - 1) {
			finish()
		} else {
			setStepIndex(stepIndex + 1)
		}
	}

	return <div className='w-full max-w-[560px] h-[80vh] mx-auto flex flex-col text-left'>
		<div className='pt-12 pb-6'>
			<StepProgress stepIndex={stepIndex} />
		</div>
		<div className='flex-1 min-h-0 overflow-y-auto flex flex-col justify-center'>
			<FadeIn key={stepIndex} durationMs={stepIndex === 0 ? 1000 : 300}>
				<ErrorBoundary>
					{contentOfIdx[stepIndex]}
				</ErrorBoundary>
			</FadeIn>
		</div>
		<div className='pt-6 pb-8 flex items-center justify-end gap-2'>
			{stepIndex > 0 && <BackButton onClick={() => setStepIndex(stepIndex - 1)} />}
			{/* Step 2 waits for every probe, so apply never runs on partial results. */}
			<ContinueButton onClick={onContinue} disabled={stepIndex === 1 && connectModel.isLooking}>{stepIndex === STEP_COUNT - 1 ? 'Done' : 'Continue'}</ContinueButton>
		</div>
	</div>

}
