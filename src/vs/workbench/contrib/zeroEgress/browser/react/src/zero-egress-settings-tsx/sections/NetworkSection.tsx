/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Network & privacy: the status bar's own text and blocked count (ILocalStatusService, same source), the network
// log, and the audit settings. No byte counts: the guard does not count bytes.

import React from 'react'
import ErrorBoundary from '../../sidebar-tsx/ErrorBoundary.js'
import { ZeroEgressButtonBgDarken } from '../../util/inputs.js'
import { useAccessor, useLocalStatus } from '../../util/services.js'

const SHOW_NETWORK_LOG_COMMAND_ID = 'zeroEgress.showNetworkLog'
const CLICK_HINT = 'Click to open the network log.' // the status bar's hint; here the button below does that

export const NetworkSection = () => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const environmentService = accessor.get('IEnvironmentService')
	const nativeHostService = accessor.get('INativeHostService')
	const { text, tooltip, blocked, kind } = useLocalStatus()

	const glyph = kind === 'internet' ? '▲' : kind ? '●' : '?' // as in the title bar pill
	const label = text.replace(/\$\([^)]*\)\s*/g, '') // the status bar's text without its codicon
	const lines = tooltip.split(/(?<=\.)\s+/).filter(l => l && l !== CLICK_HINT)

	return <ErrorBoundary>
		<div>
			<div className='rounded-sm border border-ze-border-2 bg-ze-bg-1 px-4 py-3 select-text'>
				<div className='text-base'>
					<span className={kind === 'internet' ? 'text-ze-warning' : kind ? 'text-ze-ok' : 'text-ze-fg-3'}>{glyph}</span> {label}
				</div>
				{lines.map((line, i) => <div key={i} className='text-sm text-ze-fg-3 mt-1'>{line}</div>)}
			</div>

			<div className='text-sm mt-4'>{`${blocked} blocked ${blocked === 1 ? 'connection' : 'connections'} this session`}</div>

			<div className='flex flex-col gap-2 mt-4 max-w-48 w-full'>
				<ZeroEgressButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand(SHOW_NETWORK_LOG_COMMAND_ID) }}>
					View network log
				</ZeroEgressButtonBgDarken>
				<ZeroEgressButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.openSettings', { query: 'zeroEgress.audit' }) }}>
					Audit settings
				</ZeroEgressButtonBgDarken>
				<ZeroEgressButtonBgDarken className='px-4 py-1' onClick={() => { nativeHostService.showItemInFolder(environmentService.logsHome.fsPath) }}>
					Open logs
				</ZeroEgressButtonBgDarken>
			</div>
		</div>
	</ErrorBoundary>
}
