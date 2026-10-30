/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// New parts of the Models section: each provider's live status, and which model each feature uses.

import React, { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { FeatureName, RefreshableProviderName } from '../../../../../common/zeroEgressSettingsTypes.js'
import ErrorBoundary from '../../sidebar-tsx/ErrorBoundary.js'
import { ZeroEgressSwitch } from '../../util/inputs.js'
import { useAccessor, useRefreshModelState, useSettingsState } from '../../util/services.js'
import { ModelDropdown } from '../ModelDropdown.js'

/** `● Connected · N models` / `Not running` / `Checking…`, from IRefreshModelService.state */
export const ProviderStatus = ({ providerName }: { providerName: RefreshableProviderName }) => {
	const refreshModelState = useRefreshModelState()
	const settingsState = useSettingsState()
	const { state } = refreshModelState[providerName]

	if (state === 'finished') {
		const n = settingsState.settingsOfProvider[providerName].models.filter(m => m.type === 'autodetected').length
		return <span className='text-xs text-ze-ok whitespace-nowrap'>● Connected · {n} {n === 1 ? 'model' : 'models'}</span>
	}
	if (state === 'error') {
		return <span className='text-xs text-ze-fg-3 whitespace-nowrap'>Not running</span>
	}
	// 'init' with auto-detect off: nothing checks until a manual refresh, so claim nothing
	if (state === 'init' && !settingsState.globalSettings.autoRefreshModels) {
		return null
	}
	return <span className='text-xs text-ze-fg-3 whitespace-nowrap'>Checking…</span>
}

// the class list stays inline: scope-tailwind prefixes className attributes, not string constants
const FeatureModelDropdown = ({ featureName }: { featureName: FeatureName }) => {
	return <ModelDropdown featureName={featureName} className='text-xs text-ze-fg-3 bg-ze-bg-1 border border-ze-border-1 rounded p-0.5 px-1' />
}

const UseForRow = ({ label, children }: { label: string, children: React.ReactNode }) => {
	return <div className='flex items-center gap-4 my-2'>
		<span className='w-40 shrink-0 text-sm'>{label}</span>
		<div className='flex items-center gap-x-2 min-w-0'>{children}</div>
	</div>
}

// Apply and Commit messages may follow the Chat model; their dropdown shows when they don't
const SyncedModelRow = ({ label, featureName, settingName }: { label: string, featureName: FeatureName, settingName: 'syncApplyToChat' | 'syncSCMToChat' }) => {
	const accessor = useAccessor()
	const zeroEgressSettingsService = accessor.get('IZeroEgressSettingsService')
	const settingsState = useSettingsState()
	const synced = settingsState.globalSettings[settingName]

	return <UseForRow label={label}>
		<ZeroEgressSwitch
			size='xs'
			value={synced}
			onChange={(newVal) => zeroEgressSettingsService.setGlobalSetting(settingName, newVal)}
		/>
		<span className='text-ze-fg-3 text-xs pointer-events-none whitespace-nowrap'>{synced ? 'Same as Chat model' : 'Different model'}</span>
		<div className={synced ? 'hidden' : ''}>
			<FeatureModelDropdown featureName={featureName} />
		</div>
	</UseForRow>
}

/** Use for: Agent & chat, Tab autocomplete, Quick edit ⌘K; under More: Apply and Commit messages */
export const UseForModels = () => {
	const settingsState = useSettingsState()
	const [showMore, setShowMore] = useState(false)

	return <ErrorBoundary>
		<div>
			<h3 className='text-xl mb-1'>Use for</h3>
			<UseForRow label='Agent & chat'>
				<FeatureModelDropdown featureName='Chat' />
			</UseForRow>
			<UseForRow label='Tab autocomplete'>
				<FeatureModelDropdown featureName='Autocomplete' />
				{settingsState.globalSettings.enableAutocomplete ? null
					: <span className='text-ze-fg-3 text-xs whitespace-nowrap'>Off (turn it on under Editor)</span>}
			</UseForRow>
			<UseForRow label='Quick edit ⌘K'>
				<FeatureModelDropdown featureName='Ctrl+K' />
			</UseForRow>

			<button
				className='flex items-center gap-1 text-sm text-ze-fg-3 hover:text-ze-fg-1 mt-2'
				onClick={() => setShowMore(v => !v)}
				aria-expanded={showMore}
			>
				<ChevronRight className={`size-3 transition-transform ${showMore ? 'rotate-90' : ''}`} />
				More
			</button>
			<div className={showMore ? 'pl-4' : 'hidden'}>
				<SyncedModelRow label='Apply' featureName='Apply' settingName='syncApplyToChat' />
				<SyncedModelRow label='Commit messages' featureName='SCM' settingName='syncSCMToChat' />
			</div>
		</div>
	</ErrorBoundary>
}
