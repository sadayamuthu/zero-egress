/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react'
import { HunkState } from '../../../../common/agentReview.js'

const ADDED_BG = 'var(--vscode-diffEditor-insertedLineBackground, var(--vscode-zeroEgress-greenBG))'
const REMOVED_BG = 'var(--vscode-diffEditor-removedLineBackground, var(--vscode-zeroEgress-redBG))'

type LineKind = 'context' | 'removed' | 'added'

const Line = ({ kind, text }: { kind: LineKind, text: string }) => {
	const prefix = kind === 'removed' ? '−' : kind === 'added' ? '+' : ' '
	return <div
		className={`flex whitespace-pre ${kind === 'context' ? 'text-ze-fg-3' : 'text-ze-fg-1'}`}
		style={kind === 'context' ? undefined : { backgroundColor: kind === 'added' ? ADDED_BG : REMOVED_BG }}
	>
		<span className='flex-shrink-0 w-5 text-center select-none opacity-70'>{prefix}</span>
		<span>{text || ' '}</span>
	</div>
}

const Lines = ({ kind, lines }: { kind: LineKind, lines: readonly string[] }) => <>
	{lines.map((l, i) => <Line key={i} kind={kind} text={l} />)}
</>

/** class names must be written inside className (the scope-tailwind build only prefixes them there) */
export const ReviewButton = ({ primary, ...props }: { primary?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) =>
	<button {...props} className={`px-2 py-0.5 rounded text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed ${primary ? 'bg-ze-accent text-ze-on-accent hover:bg-ze-accent-hover' : 'bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]'}`} />

/** One hunk as unified lines: context, base lines (−), agent lines (+). A conflict shows the user's lines against the agent's version. */
export const HunkView = ({ state, before, after, focused, busy, mod, onFocus, onAccept, onReject }: {
	state: HunkState,
	/** up to 3 unchanged lines around the hunk (empty when unknown) */
	before: readonly string[],
	after: readonly string[],
	focused: boolean,
	busy: boolean,
	/** modifier label: ⌘ on macOS, Ctrl+ elsewhere */
	mod: string,
	onFocus: () => void,
	onAccept: () => void,
	onReject: () => void,
}) => {
	const { hunk } = state
	const isConflict = state.status === 'conflict'
	// the user's line number (the base's drifts once other hunks or the user's edits shift lines); an insertion shows the line above it
	const line = (hunk.baseLines.length ? state.currentStart : Math.max(state.currentStart - 1, 0)) + 1

	return <div
		className={`rounded border ${focused ? 'border-ze-ring-color' : 'border-ze-border-4'} overflow-hidden`}
		onMouseDown={onFocus}
		data-hunk-focused={focused || undefined}
	>
		<div className='flex items-center gap-2 px-2 py-1 bg-ze-bg-2-alt text-xs'>
			<span className='text-ze-fg-3 select-none'>Line {line}</span>
			{isConflict ? <span className='text-ze-warning' title='You changed these lines too'>You changed these lines too</span> : null}
			<span className='flex-1' />
			{isConflict ? <>
				<ReviewButton disabled={busy} onClick={onReject} title={`Keep your lines (${mod}N)`}>Keep mine</ReviewButton>
				<ReviewButton primary disabled={busy} onClick={onAccept} title={`Replace your lines with the agent's (${mod}Y)`}>Use agent's</ReviewButton>
			</> : <>
				<ReviewButton disabled={busy} onClick={onReject}>Reject {mod}N</ReviewButton>
				<ReviewButton primary disabled={busy} onClick={onAccept}>Accept {mod}Y</ReviewButton>
			</>}
		</div>
		<div className='font-mono text-xs leading-5 overflow-x-auto bg-ze-bg-3 py-1'>
			<Lines kind='context' lines={before} />
			{state.status === 'conflict' ? <>
				<div className='px-2 pt-1 text-[11px] text-ze-fg-3 select-none'>Yours</div>
				<Lines kind='removed' lines={state.currentLines} />
				<div className='px-2 pt-1 text-[11px] text-ze-fg-3 select-none'>Agent's</div>
				<Lines kind='added' lines={state.agentVersion} />
			</> : <>
				<Lines kind='removed' lines={hunk.baseLines} />
				<Lines kind='added' lines={hunk.agentLines} />
			</>}
			<Lines kind='context' lines={after} />
		</div>
	</div>
}
