/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Home: the editor area of a window with no folder or workspace open.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isMacintosh, isNative, isWindows } from '../../../../../../../base/common/platform.js'
import { splitRecentLabel } from '../../../../../../../base/common/labels.js'
import { Schemas } from '../../../../../../../base/common/network.js'
import { URI } from '../../../../../../../base/common/uri.js'
import { Verbosity } from '../../../../../../../platform/label/common/label.js'
import { isRecentFolder } from '../../../../../../../platform/workspaces/common/workspaces.js'
import { countsByFolderKey, folderKey, reviewLabel } from '../../../../common/homeRecents.js'
import { useAccessor, useIsDark } from '../util/services.js'
import { ZeroEgressWordmark } from '../util/ZeroEgressWordmark.js'
import { ModelDropdown } from '../zero-egress-settings-tsx/ModelDropdown.js'
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'

const MAX_RECENTS = 8
const OPEN_SIDEBAR_COMMAND = 'zeroEgress.sidebar.open'
const CLONE_COMMAND = 'zeroEgress.cloneRepo'
const OPEN_FOLDER_COMMAND = isMacintosh && isNative ? 'workbench.action.files.openFileFolder' : 'workbench.action.files.openFolder'
const CASE_INSENSITIVE_PATHS = isMacintosh || isWindows

interface RecentRow { folderUri: URI; name: string; parentPath: string; fullPath: string; remoteAuthority?: string }

export const Home = () => {
	const isDark = useIsDark()
	return <div className={`@@ze-scope ${isDark ? 'dark' : ''}`} style={{ width: '100%', height: '100%' }}>
		<ErrorBoundary>
			<HomeContent />
		</ErrorBoundary>
	</div>
}

const HomeContent = () => {
	return <div className='w-full h-full overflow-y-auto bg-ze-bg-3 text-ze-fg-1'>
		<div className='mx-auto w-full max-w-[560px] px-6 py-12 flex flex-col items-stretch gap-8'>
			<div className='flex justify-center'>
				<ZeroEgressWordmark markWidth={64} fontSize={28} gapClass='gap-3' />
			</div>
			<PromptCard />
			<Recents />
			<HomeButtons />
		</div>
	</div>
}

const PromptCard = () => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const chatThreadService = accessor.get('IChatThreadService')
	const ref = useRef<HTMLTextAreaElement | null>(null)
	const [text, setText] = useState('')

	useEffect(() => { ref.current?.focus() }, [])

	const send = useCallback(async () => {
		const userMessage = text.trim()
		if (!userMessage) { return }
		setText('')
		try {
			await commandService.executeCommand(OPEN_SIDEBAR_COMMAND)
			chatThreadService.openNewThread()
			const threadId = chatThreadService.state.currentThreadId
			await chatThreadService.addUserMessageAndStreamResponse({ userMessage, threadId })
		} catch (e) {
			accessor.get('INotificationService').error(e instanceof Error ? e.message : String(e))
		}
	}, [text, commandService, chatThreadService, accessor])

	return <div className='rounded-lg border border-ze-border-2 bg-ze-bg-1 focus-within:border-ze-ring-color'>
		<textarea
			ref={ref}
			className='block w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm text-ze-fg-1 placeholder:text-ze-fg-3'
			rows={3}
			placeholder='What do you want to build?'
			aria-label='What do you want to build?'
			value={text}
			onChange={e => setText(e.target.value)}
			onKeyDown={e => {
				if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
					e.preventDefault()
					// sent after the key event: opening and focusing the chat panel inside a real Enter keydown froze the window
					setTimeout(() => { send() }, 0)
				}
			}}
		/>
		<div className='flex items-center px-2 pb-2'>
			<ModelDropdown featureName='Chat' className='text-xs text-ze-fg-3 bg-ze-bg-1 rounded' />
		</div>
	</div>
}

const Recents = () => {
	const accessor = useAccessor()
	const workspacesService = accessor.get('IWorkspacesService')
	const labelService = accessor.get('ILabelService')
	const hostService = accessor.get('IHostService')
	const agentsService = accessor.get('IBackgroundAgentsService')

	const [rows, setRows] = useState<RecentRow[] | undefined>(undefined)
	const [counts, setCounts] = useState<Map<string, number>>(new Map())

	useEffect(() => {
		let alive = true
		workspacesService.getRecentlyOpened().then(r => r.workspaces, () => []).then(workspaces => {
			if (!alive) { return }
			const folders: RecentRow[] = []
			for (const w of workspaces) {
				if (!isRecentFolder(w)) { continue }
				const fullPath = w.label || labelService.getWorkspaceLabel(w.folderUri, { verbose: Verbosity.LONG })
				const { name, parentPath } = splitRecentLabel(fullPath)
				folders.push({ folderUri: w.folderUri, name, parentPath, fullPath, remoteAuthority: w.remoteAuthority })
				if (folders.length === MAX_RECENTS) { break }
			}
			setRows(folders)
		})
		return () => { alive = false }
	}, [workspacesService, labelService])

	useEffect(() => {
		let alive = true
		let seq = 0
		const refresh = () => {
			const mine = ++seq
			agentsService.pendingReviewCountsByFolder().then(m => {
				if (alive && mine === seq) { setCounts(countsByFolderKey(m, CASE_INSENSITIVE_PATHS)) }
			}, () => { })
		}
		refresh()
		const d = agentsService.onDidChange(refresh)
		return () => { alive = false; d.dispose() }
	}, [agentsService])

	const countOf = useMemo(() => (uri: URI) =>
		uri.scheme === Schemas.file ? counts.get(folderKey(uri.fsPath, CASE_INSENSITIVE_PATHS)) ?? 0 : 0
		, [counts])

	if (!rows || rows.length === 0) { return null }

	return <div className='flex flex-col gap-1'>
		<div className='text-xs text-ze-fg-3 px-2 select-none'>Recent</div>
		<ul className='flex flex-col'>
			{rows.map(row => {
				const label = reviewLabel(countOf(row.folderUri))
				return <li key={row.folderUri.toString()}>
					<button
						type='button'
						className='w-full flex items-baseline gap-2 px-2 py-1.5 rounded-md text-left text-sm hover:bg-ze-bg-2-hover'
						title={row.fullPath}
						onClick={() => {
							hostService.openWindow([{ folderUri: row.folderUri }], {
								forceReuseWindow: true,
								remoteAuthority: row.remoteAuthority || null,
							})
						}}
					>
						<span className='flex-shrink-0 text-ze-fg-1'>{row.name}</span>
						<span className='min-w-0 flex-1 truncate text-xs text-ze-fg-3'>{row.parentPath}</span>
						{label ? <span className='flex-shrink-0 text-xs text-ze-warning'>{label}</span> : null}
					</button>
				</li>
			})}
		</ul>
	</div>
}

const HomeButtons = () => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const keybindingService = accessor.get('IKeybindingService')
	const openFolderKey = keybindingService.lookupKeybinding(OPEN_FOLDER_COMMAND)?.getLabel()

	return <div className='flex gap-2 justify-center'>
		<button
			type='button'
			className='px-3 py-1.5 rounded-md text-sm transition-colors bg-ze-accent text-ze-on-accent hover:bg-ze-accent-hover'
			onClick={() => { commandService.executeCommand(OPEN_FOLDER_COMMAND) }}
		>
			Open folder{openFolderKey ? <span className='ml-2 opacity-70'>{openFolderKey}</span> : null}
		</button>
		<button
			type='button'
			className='px-3 py-1.5 rounded-md text-sm transition-colors border border-ze-border-2 bg-ze-bg-1 text-ze-fg-2 hover:bg-ze-bg-2-hover'
			onClick={() => { commandService.executeCommand(CLONE_COMMAND) }}
		>
			Clone repo
		</button>
	</div>
}
