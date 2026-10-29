/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useState } from 'react'
import { useAccessor } from '../util/services.js'
import { AgentSummary } from '../../../backgroundAgentsServiceInterface.js'

export const AgentList = ({ agents, selectedThreadId, onSelect, onNew, availability }: {
	agents: readonly AgentSummary[],
	selectedThreadId: string | undefined,
	onSelect: (threadId: string) => void,
	onNew: () => void,
	availability: { ok: true } | { ok: false, reason: string } | undefined,
}) => {
	const canStart = availability?.ok === true
	return <div className='w-full h-full flex flex-col overflow-hidden'>
		<div className='flex-shrink-0 flex items-center justify-between px-3 py-2'>
			<span className='text-xs font-semibold uppercase tracking-wide text-ze-fg-3 select-none'>Agents</span>
			<button
				className='px-2 py-0.5 rounded text-sm bg-ze-accent text-ze-on-accent hover:bg-ze-accent-hover disabled:opacity-50 disabled:cursor-not-allowed'
				disabled={!canStart}
				onClick={onNew}
			>+ New</button>
		</div>
		{availability && !availability.ok ? <div className='px-3 pb-2 text-sm text-ze-warning'>{availability.reason}</div> : null}
		<div className='flex-1 overflow-y-auto' role='listbox' aria-label='Agents'>
			{agents.map(a => <AgentRow key={a.threadId} agent={a} selected={a.threadId === selectedThreadId} onSelect={onSelect} />)}
		</div>
	</div>
}

const AgentRow = ({ agent, selected, onSelect }: { agent: AgentSummary, selected: boolean, onSelect: (threadId: string) => void }) => {
	const accessor = useAccessor()
	const agentsService = accessor.get('IBackgroundAgentsService')
	const [confirming, setConfirming] = useState(false)

	return <div
		role='option'
		aria-selected={selected}
		tabIndex={0}
		className={`group px-3 py-2 cursor-pointer select-none border-l-2 ${selected ? 'bg-ze-bg-2-hover border-ze-accent' : 'border-transparent hover:bg-ze-bg-2-hover'}`}
		onClick={() => onSelect(agent.threadId)}
		onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(agent.threadId) } }}
		onMouseLeave={() => setConfirming(false)}
	>
		<div className='flex items-center gap-2'>
			<span className='flex-1 truncate text-sm text-ze-fg-1' title={agent.title}>{agent.title || 'Untitled agent'}</span>
			<button
				className={`text-xs px-1 rounded ${confirming ? 'text-ze-warning' : 'text-ze-fg-3 opacity-0 group-hover:opacity-100 focus:opacity-100'} hover:text-ze-fg-1`}
				title='Delete this agent and its worktree'
				onClick={e => {
					e.stopPropagation()
					if (!confirming) { setConfirming(true); return }
					setConfirming(false)
					agentsService.deleteAgent(agent.threadId).catch(err => console.error('Agents view: delete failed', err))
				}}
			>{confirming ? 'Delete?' : '✕'}</button>
		</div>
		<div className='flex items-center gap-1.5 mt-0.5'>
			{/* running/waiting: accent; needs your OK/review, failed: warning; done: fg-3 */}
			<span className={`inline-block w-2 h-2 rounded-full ${agent.status.kind === 'running' || agent.status.kind === 'waiting' ? 'bg-ze-accent' : agent.status.kind === 'done' ? 'bg-ze-fg-3' : 'bg-ze-warning'}`} />
			<span className='text-xs text-ze-fg-3'>{agent.status.label}</span>
		</div>
	</div>
}
