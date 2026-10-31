/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Keyboard: the ZeroEgress shortcuts at a glance, and the full keyboard shortcuts editor.

import React from 'react'
import ErrorBoundary from '../../sidebar-tsx/ErrorBoundary.js'
import { ZeroEgressButtonBgDarken } from '../../util/inputs.js'
import { useAccessor } from '../../util/services.js'

const SHORTCUTS: readonly [keys: string, action: string][] = [
	['⇧⌘A', 'Agents'],
	['⇧⌘E', 'Editor (from Agents)'],
	['⌘Y / ⌘N', 'Accept or reject a change'],
	['⌥⌘Y / ⌥⌘N', 'Accept or reject a file'],
	['⌘⏎', 'Accept all'],
	['⌘K', 'Quick edit'],
	['⌘L', 'Add selection'],
]

export const KeyboardSection = () => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')

	return <ErrorBoundary>
		<div>
			<table className='text-sm mb-4'>
				<tbody>
					{SHORTCUTS.map(([keys, action]) => <tr key={keys}>
						<td className='pr-8 py-1 font-mono text-ze-fg-1 whitespace-nowrap'>{keys}</td>
						<td className='py-1 text-ze-fg-3'>{action}</td>
					</tr>)}
				</tbody>
			</table>
			<ZeroEgressButtonBgDarken className='px-4 py-1 w-fit' onClick={() => { commandService.executeCommand('workbench.action.openGlobalKeybindings') }}>
				Open keyboard shortcuts
			</ZeroEgressButtonBgDarken>
		</div>
	</ErrorBoundary>
}
