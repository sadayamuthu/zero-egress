/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react'
import '../styles.css'
import { useAccessor, useBackgroundAgents, useChatThreadsState, useIsDark } from '../util/services.js'
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { ChatThreadView } from '../sidebar-tsx/SidebarChat.js'
import { FileReview } from '../../../../common/agentReview.js'
import { AGENT_WORKTREE_REMOVED_MESSAGE } from '../../../../common/backgroundAgentTypes.js'
import { AgentList } from './AgentList.js'
import { ReviewColumn } from './ReviewColumn.js'

/** Shared with agentsViewContribution.ts: the contribution calls in, React fills in the functions. */
export type AgentsViewBridge = {
	/** the overlay was shown: re-check availability, open the new-agent prompt and focus it */
	onShow?: () => void
	/** ⌘⏎ (zeroEgress.agentsView.acceptAll): accept every clean change of the selected agent */
	acceptAllSelected?: () => void
}

type Availability = { ok: true } | { ok: false, reason: string } | undefined

export const AgentsView = ({ bridge }: { bridge: AgentsViewBridge }) => {
	const isDark = useIsDark()
	return <div className={`@@ze-scope ${isDark ? 'dark' : ''}`} style={{ width: '100%', height: '100%' }}>
		<div className='w-full h-full bg-ze-bg-3 text-ze-fg-1'>
			<ErrorBoundary>
				<AgentsViewInner bridge={bridge} />
			</ErrorBoundary>
		</div>
	</div>
}

const AgentsViewInner = ({ bridge }: { bridge: AgentsViewBridge }) => {
	const accessor = useAccessor()
	const agentsService = accessor.get('IBackgroundAgentsService')
	const agents = useBackgroundAgents()
	const chatThreadsState = useChatThreadsState()

	const [availability, setAvailability] = useState<Availability>(undefined)
	const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
	const [promptOpen, setPromptOpen] = useState(false)
	const [focusPromptSeq, setFocusPromptSeq] = useState(0)

	const checkAvailability = useCallback(() => {
		agentsService.availability().then(setAvailability, e => setAvailability({ ok: false, reason: String(e?.message ?? e) }))
	}, [agentsService])

	// selection falls back to the newest agent
	const selected = agents.find(a => a.threadId === selectedId) ?? agents[0]
	const selectedThreadId = selected?.threadId
	const canStart = availability?.ok === true

	// ----- review of the selected agent -----
	// tagged with its thread: after a switch, the previous agent's files must never render (or be acted on) under the new agent
	const [reviewState, setReviewState] = useState<{ threadId: string, reviews: FileReview[] } | undefined>(undefined)
	const reviews = reviewState && reviewState.threadId === selectedThreadId ? reviewState.reviews : undefined
	const [activePath, setActivePath] = useState<string | undefined>(undefined)
	const reviewSeq = useRef(0)
	const refreshReview = useCallback(async () => {
		const seq = ++reviewSeq.current
		const threadId = selectedThreadId
		if (!threadId) { setReviewState(undefined); return }
		try {
			const r = await agentsService.getReview(threadId)
			if (seq === reviewSeq.current) { setReviewState({ threadId, reviews: r }) }
		} catch (e) {
			console.error('Agents view: could not read the review', e)
		}
	}, [agentsService, selectedThreadId])

	// review writes (buttons, keys and ⌘⏎) go one at a time; each re-reads the review afterwards, also when it failed
	const [busy, setBusy] = useState(false)
	const busyRef = useRef(false)
	const run = useCallback(async (write: () => Promise<void>) => {
		if (busyRef.current) { return }
		busyRef.current = true
		setBusy(true)
		try {
			await write()
		} catch (e) {
			console.error('Agents view: review write failed', e)
		} finally {
			try { await refreshReview() } finally {
				busyRef.current = false
				setBusy(false)
			}
		}
	}, [refreshReview])

	// re-read when the selection, its status or its pending count changes
	useEffect(() => { refreshReview() }, [refreshReview, selected?.status.label, selected?.changedFiles])
	useEffect(() => { setActivePath(undefined) }, [selectedThreadId])

	// ----- bridge -----
	const acceptAll = useCallback(() => {
		if (!selectedThreadId) { return }
		run(() => agentsService.acceptAll(selectedThreadId))
	}, [agentsService, selectedThreadId, run])

	const openPrompt = useCallback(() => {
		setPromptOpen(true)
		setFocusPromptSeq(n => n + 1)
	}, [])

	useEffect(() => {
		bridge.acceptAllSelected = acceptAll
		return () => { if (bridge.acceptAllSelected === acceptAll) { bridge.acceptAllSelected = undefined } }
	}, [bridge, acceptAll])
	useEffect(() => {
		bridge.onShow = () => { checkAvailability(); openPrompt() }
		bridge.onShow() // React mounts on the first show
		return () => { bridge.onShow = undefined }
	}, [bridge, checkAvailability, openPrompt])
	useEffect(() => {
		const d = accessor.get('IWorkspaceContextService').onDidChangeWorkspaceFolders(() => checkAvailability())
		return () => d.dispose()
	}, [accessor, checkAvailability])

	const onStarted = useCallback((threadId: string) => {
		setSelectedId(threadId)
		setPromptOpen(false)
	}, [])

	const agentInfo = selectedThreadId ? chatThreadsState.allThreads[selectedThreadId]?.agent : undefined
	const removed = !!agentInfo && !agentInfo.worktreePath

	return <div className='w-full h-full flex overflow-hidden'>
		<div className='flex-shrink-0 h-full border-r border-ze-border-4 bg-ze-bg-2' style={{ width: 240 }}>
			<AgentList
				agents={agents}
				selectedThreadId={selectedThreadId}
				onSelect={setSelectedId}
				onNew={openPrompt}
				availability={availability}
			/>
		</div>

		<div className='flex-1 min-w-0 h-full flex flex-col overflow-hidden'>
			{promptOpen && canStart ? <NewAgentPrompt
				focusSeq={focusPromptSeq}
				onStarted={onStarted}
				onClose={() => setPromptOpen(false)}
				hasAgents={agents.length > 0}
			/> : null}
			{selectedThreadId ? <>
				<SetupRow threadId={selectedThreadId} />
				<ChangedFilesList reviews={reviews ?? []} activePath={activePath} onSelect={setActivePath} />
				<div className='flex-1 min-h-0'>
					<ChatThreadView
						key={selectedThreadId}
						threadId={selectedThreadId}
						variant='agents'
						inputDisabledReason={removed ? AGENT_WORKTREE_REMOVED_MESSAGE : undefined}
					/>
				</div>
			</> : !promptOpen || !canStart ? <div className='p-6 text-sm text-ze-fg-3 select-none'>No agents yet.</div> : null}
		</div>

		<div className='flex-shrink-0 h-full border-l border-ze-border-4 bg-ze-bg-2' style={{ width: '45%' }}>
			{selectedThreadId && agentInfo && !reviews ? <div className='p-6 text-sm text-ze-fg-3 select-none'>Loading changes…</div>
				: selectedThreadId && agentInfo && reviews ? <ReviewColumn
				key={selectedThreadId}
				threadId={selectedThreadId}
				agent={agentInfo}
				reviews={reviews}
				activePath={activePath}
				onSelectPath={setActivePath}
				busy={busy}
				run={run}
				onRefresh={refreshReview}
				onAcceptAll={acceptAll}
			/> : <div className='p-6 text-sm text-ze-fg-3 select-none'>Changes from the selected agent show here.</div>}
		</div>
	</div>
}

const NewAgentPrompt = ({ focusSeq, onStarted, onClose, hasAgents }: { focusSeq: number, onStarted: (threadId: string) => void, onClose: () => void, hasAgents: boolean }) => {
	const accessor = useAccessor()
	const agentsService = accessor.get('IBackgroundAgentsService')
	const ref = useRef<HTMLTextAreaElement | null>(null)
	const [text, setText] = useState('')
	const [starting, setStarting] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)

	useEffect(() => { ref.current?.focus() }, [focusSeq])

	const start = async () => {
		const prompt = text.trim()
		if (!prompt || starting) { return }
		setStarting(true)
		setError(undefined)
		try {
			const threadId = await agentsService.startAgent(prompt)
			setText('')
			onStarted(threadId)
		} catch (e) {
			setError(String((e as Error)?.message ?? e))
		} finally {
			setStarting(false)
		}
	}

	return <div className='flex-shrink-0 p-3 border-b border-ze-border-4 bg-ze-bg-2'>
		<div className='text-xs text-ze-fg-3 mb-1 select-none'>New agent</div>
		<textarea
			ref={ref}
			className='w-full resize-none rounded px-2 py-1.5 text-sm bg-ze-bg-1 text-ze-fg-1 border border-ze-border-2 focus:border-ze-ring-color'
			rows={3}
			placeholder='Describe the task. The agent works in its own copy of this repository.'
			value={text}
			disabled={starting}
			onChange={e => setText(e.target.value)}
			onKeyDown={e => {
				if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); start() }
				else if (e.key === 'Escape' && hasAgents) { e.preventDefault(); e.stopPropagation(); onClose() }
			}}
		/>
		<div className='flex items-center gap-2 mt-1'>
			<button
				className='px-2 py-1 rounded text-sm bg-ze-accent text-ze-on-accent hover:bg-ze-accent-hover disabled:opacity-50'
				disabled={starting || !text.trim()}
				onClick={start}
			>{starting ? 'Starting…' : 'Start agent'}</button>
			{hasAgents ? <button
				className='px-2 py-1 rounded text-sm text-ze-fg-3 hover:text-ze-fg-1'
				onClick={onClose}
			>Cancel</button> : null}
			{error ? <span className='text-sm text-vscode-error-fg truncate'>{error}</span> : null}
		</div>
	</div>
}

const SetupRow = ({ threadId }: { threadId: string }) => {
	const chatThreadsState = useChatThreadsState()
	const setup = chatThreadsState.allThreads[threadId]?.agent?.setup
	if (!setup) { return null }
	const ok = setup.exitCode === 0
	return <details className='flex-shrink-0 px-4 py-1.5 border-b border-ze-border-4 text-sm'>
		<summary className='cursor-pointer select-none'>
			<span className={ok ? 'text-ze-ok' : 'text-ze-warning'}>{ok ? '✓' : '✗'}</span>
			<span className='ml-2'>Setup: <code>{setup.command}</code></span>
			{!ok ? <span className='ml-2 text-ze-fg-3'>{setup.exitCode === null ? '(stopped)' : `(exit ${setup.exitCode})`}</span> : null}
		</summary>
		<pre className='mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-ze-fg-2 bg-ze-bg-1 rounded p-2'>{setup.outputTail || '(no output)'}</pre>
	</details>
}

const ChangedFilesList = ({ reviews, activePath, onSelect }: { reviews: FileReview[], activePath: string | undefined, onSelect: (path: string) => void }) => {
	if (reviews.length === 0) { return null }
	return <div className='flex-shrink-0 px-4 py-1.5 border-b border-ze-border-4 text-sm flex flex-wrap gap-x-3 gap-y-1'>
		<span className='text-ze-fg-3 select-none'>Changed:</span>
		{reviews.map(r => <button
			key={r.path}
			className={`hover:underline ${r.path === activePath ? 'text-ze-fg-1 font-medium' : 'text-ze-fg-2'}`}
			onClick={() => onSelect(r.path)}
			title={r.path}
		>
			{r.path.split('/').pop()}
			<span className='ml-1 text-ze-ok'>+{r.added}</span>
			<span className='ml-0.5 text-vscode-error-fg'>−{r.removed}</span>
		</button>)}
	</div>
}
