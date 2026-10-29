/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useAccessor } from '../util/services.js'
import { FileReview, HunkState } from '../../../../common/agentReview.js'
import { BackgroundAgentInfo } from '../../../../common/backgroundAgentTypes.js'
import { FILE_CONFLICT_ACCEPT_TOOLTIP } from '../../../backgroundAgentsServiceInterface.js'
import { URI } from '../../../../../../../base/common/uri.js'
import { isMacintosh } from '../../../../../../../base/common/platform.js'
import { HunkView, ReviewButton } from './HunkView.js'

const CONTEXT_LINES = 3
const MOD = isMacintosh ? '⌘' : 'Ctrl+'
const ACCEPT_ALL_KEY = isMacintosh ? '⌘⏎' : 'Ctrl+Enter'

const splitLines = (text: string): string[] => {
	if (text === '') { return [] }
	const lines = text.split(/\r?\n/)
	if (text.endsWith('\n')) { lines.pop() }
	return lines
}

/**
 * Context for each hunk of a modified file, read from the agent's file in the worktree: lines outside the hunks are the same
 * in the base and the agent's text, so the agent's lines next to a hunk are the base lines next to it.
 */
const contextOf = (hunks: readonly HunkState[], agentLines: readonly string[] | undefined) => {
	if (!agentLines) { return hunks.map(() => ({ before: [] as string[], after: [] as string[] })) }
	const spans = hunks.map(h => ({ start: h.hunk.agentStart, end: h.hunk.agentStart + h.hunk.agentLines.length }))
	return hunks.map((h, i) => {
		if (h.status === 'conflict') { return { before: [], after: [] } } // the user's region can be wider than the agent's hunk
		const { start, end } = spans[i]
		const prevEnd = Math.max(0, ...spans.filter(s => s.end <= start).map(s => s.end))
		const nextStart = Math.min(agentLines.length, ...spans.filter(s => s.start >= end && s !== spans[i]).map(s => s.start))
		return {
			before: agentLines.slice(Math.max(prevEnd, start - CONTEXT_LINES), start),
			after: agentLines.slice(end, Math.min(nextStart, end + CONTEXT_LINES)),
		}
	})
}

export const ReviewColumn = ({ threadId, agent, reviews, activePath, onSelectPath, onChanged, onAcceptAll }: {
	threadId: string,
	agent: BackgroundAgentInfo,
	reviews: FileReview[],
	activePath: string | undefined,
	onSelectPath: (path: string) => void,
	/** re-read the review after a write */
	onChanged: () => Promise<void>,
	onAcceptAll: () => Promise<void>,
}) => {
	const accessor = useAccessor()
	const agentsService = accessor.get('IBackgroundAgentsService')
	const fileService = accessor.get('IFileService')

	const [busy, setBusy] = useState(false)
	const [focusedIdx, setFocusedIdx] = useState(0)
	const [agentLines, setAgentLines] = useState<string[] | undefined>(undefined)
	const columnRef = useRef<HTMLDivElement | null>(null)

	const file = reviews.find(r => r.path === activePath) ?? reviews[0]
	const hunks = file?.hunks ?? []

	// the agent's text of the active file, for context lines
	useEffect(() => {
		let cancelled = false
		setAgentLines(undefined)
		if (!file || file.kind !== 'modified' || !agent.worktreePath) { return }
		const uri = URI.joinPath(URI.file(agent.worktreePath), ...file.path.split('/'))
		fileService.readFile(uri).then(
			c => { if (!cancelled) { setAgentLines(splitLines(c.value.toString())) } },
			() => { },
		)
		return () => { cancelled = true }
	}, [fileService, agent.worktreePath, file])

	useEffect(() => { setFocusedIdx(i => Math.min(i, Math.max(hunks.length - 1, 0))) }, [hunks.length])
	useEffect(() => { setFocusedIdx(0) }, [file?.path, threadId])

	const run = useCallback(async (write: () => Promise<void>) => {
		if (busy) { return }
		setBusy(true)
		try {
			await write()
		} catch (e) {
			console.error('Agents view: review write failed', e)
		} finally {
			await onChanged()
			setBusy(false)
		}
	}, [busy, onChanged])

	const acceptHunk = (h: HunkState) => file && run(() => agentsService.acceptHunk(threadId, file.path, h))
	const rejectHunk = (h: HunkState) => file && run(() => agentsService.rejectHunk(threadId, file.path, h))

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const mod = isMacintosh ? e.metaKey : e.ctrlKey
		const key = e.key.toLowerCase()
		const handled = () => { e.preventDefault(); e.stopPropagation() }
		if (mod && !e.shiftKey && !e.altKey && (key === 'y' || key === 'n')) {
			handled() // never let ⌘N (new file) or ⌘Y reach the workbench from here
			const h = hunks[focusedIdx]
			if (h) { key === 'y' ? acceptHunk(h) : rejectHunk(h) }
		} else if (!mod && !e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
			handled()
			setFocusedIdx(i => Math.max(0, Math.min(hunks.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
		}
	}

	// keep the focused hunk in view
	useEffect(() => {
		columnRef.current?.querySelector('[data-hunk-focused]')?.scrollIntoView({ block: 'nearest' })
	}, [focusedIdx])

	const context = contextOf(hunks, agentLines)

	return <div className='w-full h-full flex flex-col overflow-hidden'>
		<div className='flex-shrink-0 flex items-center gap-2 px-3 py-2'>
			<span className='text-xs font-semibold uppercase tracking-wide text-ze-fg-3 select-none'>Review</span>
			<button className='text-xs text-ze-fg-3 hover:text-ze-fg-1' title='Refresh' onClick={() => { onChanged() }}>↻</button>
			<span className='flex-1' />
			<ReviewButton disabled={busy || reviews.length === 0} onClick={() => run(() => agentsService.rejectAll(threadId))}>Reject all</ReviewButton>
			<ReviewButton primary disabled={busy || reviews.length === 0} onClick={() => run(onAcceptAll)}>Accept all {ACCEPT_ALL_KEY}</ReviewButton>
		</div>

		{reviews.length === 0 ? <div className='px-3 py-2 text-sm text-ze-fg-3 select-none'>No pending changes.</div> : <>
			<div className='flex-shrink-0 flex overflow-x-auto border-b border-ze-border-4' role='tablist'>
				{reviews.map(r => <button
					key={r.path}
					role='tab'
					aria-selected={r === file}
					title={r.path}
					className={`flex-shrink-0 px-3 py-1.5 text-xs border-b-2 ${r === file ? 'border-ze-accent text-ze-fg-1 bg-ze-bg-3' : 'border-transparent text-ze-fg-3 hover:text-ze-fg-1'}`}
					onClick={() => onSelectPath(r.path)}
				>
					{r.path.split('/').pop()}
					<span className='ml-1.5 text-ze-ok'>+{r.added}</span>
					<span className='ml-1 text-vscode-error-fg'>−{r.removed}</span>
				</button>)}
			</div>

			{file ? <div className='flex-shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs'>
				<span className='flex-1 truncate text-ze-fg-2' title={file.path}>{file.path}{file.kind !== 'modified' ? ` (${file.kind})` : ''}</span>
				<ReviewButton disabled={busy} onClick={() => run(() => agentsService.rejectFile(threadId, file.path))}>Reject file</ReviewButton>
				<span title={file.fileConflict ? FILE_CONFLICT_ACCEPT_TOOLTIP : undefined}>
					<ReviewButton primary disabled={busy || file.fileConflict} onClick={() => run(() => agentsService.acceptFile(threadId, file.path))}>Accept file</ReviewButton>
				</span>
			</div> : null}

			<div
				ref={columnRef}
				tabIndex={0}
				className='flex-1 overflow-y-auto px-3 pb-3 space-y-2 focus:outline-none'
				onKeyDown={onKeyDown}
				aria-label={`Changes in ${file?.path ?? ''}. ${MOD}Y accepts, ${MOD}N rejects, arrow keys move between changes.`}
			>
				{file?.fileConflict ? <div className='text-sm text-ze-warning'>{FILE_CONFLICT_ACCEPT_TOOLTIP}</div> : null}
				{file?.kind === 'binary' ? <div className='text-sm text-ze-fg-3'>Binary file. Accept or reject the whole file.</div> : null}
				{file && hunks.length === 0 && file.kind !== 'binary' && !file.fileConflict ? <div className='text-sm text-ze-fg-3'>Your file already matches. Accept or reject the whole file.</div> : null}
				{hunks.map((h, i) => <HunkView
					key={`${file!.path}:${h.status}:${h.hunk.baseStart}:${h.hunk.agentStart}`}
					state={h}
					before={context[i].before}
					after={context[i].after}
					focused={i === focusedIdx}
					busy={busy}
					mod={MOD}
					onFocus={() => setFocusedIdx(i)}
					onAccept={() => acceptHunk(h)}
					onReject={() => rejectHunk(h)}
				/>)}
			</div>
		</>}
	</div>
}
