/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// New parts of the Agents section: the background agent limit and the (read-only) setup command.

import React, { useCallback } from 'react'
import ErrorBoundary from '../../sidebar-tsx/ErrorBoundary.js'
import { ZeroEgressButtonBgDarken, ZeroEgressSimpleInputBox } from '../../util/inputs.js'
import { useAccessor, useConfigurationValue } from '../../util/services.js'

// The keys, default and maximum of common/zeroEgressConfiguration.ts. Written out because the bundle keeps imports from
// outside react/src as written, and a path from this folder would not resolve from the bundle's own folder.
const AGENTS_MAX_CONCURRENT_SETTING = 'zeroEgress.agents.maxConcurrent'
const AGENTS_MAX_CONCURRENT_DEFAULT = 4
const MAX_CONCURRENT_LIMIT = 16
const AGENTS_SETUP_COMMAND_SETTING = 'zeroEgress.agents.setupCommand'

export const MaxConcurrentAgentsSetting = () => {
	const accessor = useAccessor()
	const configurationService = accessor.get('IConfigurationService')
	const value = useConfigurationValue<number>(AGENTS_MAX_CONCURRENT_SETTING) ?? AGENTS_MAX_CONCURRENT_DEFAULT

	const onChangeValue = useCallback((newVal: string) => {
		const trimmed = newVal.trim()
		if (!/^\d+$/.test(trimmed)) return // wait for a whole number
		const n = Math.min(MAX_CONCURRENT_LIMIT, Math.max(1, parseInt(trimmed, 10)))
		configurationService.updateValue(AGENTS_MAX_CONCURRENT_SETTING, n)
	}, [configurationService])

	return <ErrorBoundary>
		<div className='my-2'>
			<div className='flex items-center gap-2'>
				<span className='text-sm whitespace-nowrap'>Max concurrent background agents</span>
				<ZeroEgressSimpleInputBox
					value={String(value)}
					onChangeValue={onChangeValue}
					placeholder={String(AGENTS_MAX_CONCURRENT_DEFAULT)}
					compact={true}
					className='max-w-16'
					inputMode='numeric'
					aria-label='Max concurrent background agents'
				/>
			</div>
			<div className='py-1 text-ze-fg-3 text-xs'>{`How many background agents may run at once (1 to ${MAX_CONCURRENT_LIMIT}). Others wait their turn.`}</div>
		</div>
	</ErrorBoundary>
}

// Restricted and per workspace: shown here, edited only in the workspace's .vscode/settings.json
export const SetupCommandSetting = () => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const workspaceContextService = accessor.get('IWorkspaceContextService')
	const command = useConfigurationValue<string>(AGENTS_SETUP_COMMAND_SETTING) ?? ''
	const hasWorkspace = workspaceContextService.getWorkspace().folders.length > 0

	return <ErrorBoundary>
		<div className='my-2'>
			<div className='text-sm'>Setup command</div>
			<div className='text-ze-fg-3 text-xs mt-1'>Runs in each background agent's new worktree before it starts, for example to install dependencies. You are asked before a new or changed command runs.</div>
			<div className='my-2 px-2 py-1 bg-ze-bg-2 text-xs font-mono overflow-x-auto whitespace-nowrap rounded-sm select-text'>
				{command ? command : <span className='text-ze-fg-3'>None</span>}
			</div>
			{hasWorkspace
				? <ZeroEgressButtonBgDarken className='px-4 py-1 w-fit' onClick={() => {
					commandService.executeCommand('workbench.action.openWorkspaceSettingsFile', { revealSetting: { key: AGENTS_SETUP_COMMAND_SETTING, edit: true } })
				}}>
					Edit in workspace settings
				</ZeroEgressButtonBgDarken>
				: <div className='text-ze-fg-3 text-xs'>Open a folder to set it in that workspace's settings.</div>}
		</div>
	</ErrorBoundary>
}
