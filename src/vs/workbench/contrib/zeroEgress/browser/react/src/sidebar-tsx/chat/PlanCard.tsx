/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The chat's plan as a live card: `Plan · d of n` with a row per step (done struck through, current in the accent
// color, todo muted). Edit turns the rows into inputs (reorder, add, remove) and Done saves them through the chat
// service; Approve plan shows for a plan written in Plan mode until it is approved, while the chat is idle.

import React, { useState } from 'react';
import { useAccessor, useChatThreadsState, useChatThreadsStreamState } from '../../util/services.js';
import { planProgress } from '../composerDeps.js';
import type { PlanStep } from '../composerDeps.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { ApprovalButton } from './ApprovalCard.js';

const iconButton = 'w-5 h-5 flex items-center justify-center rounded-[4px] text-ze-fg-3 hover:text-ze-fg-1 hover:bg-ze-bg-2-hover cursor-pointer disabled:opacity-30 disabled:cursor-default';

export const PlanCard = ({ threadId }: { threadId: string }) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const plan = useChatThreadsState().allThreads[threadId]?.plan;
	const streamState = useChatThreadsStreamState(threadId);
	const [draft, setDraft] = useState<{ text: string; status: PlanStep['status'] }[] | null>(null);
	const [approving, setApproving] = useState(false);

	if (!plan) {
		return null;
	}
	const isIdle = !streamState?.isRunning; // undefined when idle; 'awaiting_user' counts as busy
	const { done, total } = planProgress(plan.steps);
	const canApprove = plan.madeInPlanMode && !plan.approvedAt && isIdle;

	const update = (i: number, text: string) => setDraft(d => d && d.map((s, j) => j === i ? { ...s, text } : s));
	const move = (i: number, by: -1 | 1) => setDraft(d => {
		if (!d || i + by < 0 || i + by >= d.length) { return d; }
		const next = [...d];
		[next[i], next[i + by]] = [next[i + by], next[i]];
		return next;
	});
	const remove = (i: number) => setDraft(d => d && d.filter((_, j) => j !== i));
	const save = () => {
		if (draft) {
			chatThreadsService.setPlanSteps(threadId, draft.map(s => ({ ...s, text: s.text.trim() })).filter(s => s.text !== ''));
		}
		setDraft(null);
	};
	const approve = async () => {
		setApproving(true);
		try { await chatThreadsService.approvePlan(threadId); }
		catch (e) { console.error('Error while approving the plan:', e); }
		finally { setApproving(false); }
	};

	return <div className='mx-0.5 my-1 px-2.5 py-2 rounded-[10px] border border-ze-border-2 bg-ze-bg-2 text-ze-fg-1 flex flex-col gap-1.5'>
		<div className='flex items-center justify-between'>
			<span className='text-[11px] uppercase tracking-wide text-ze-fg-3'>Plan · {done} of {total}</span>
			{!draft && isIdle && <button type='button' className='text-xs text-ze-accent hover:underline cursor-pointer' onClick={() => setDraft(plan.steps.map(s => ({ ...s })))}>Edit</button>}
		</div>
		{draft ? <>
			<div className='flex flex-col gap-1'>
				{draft.map((s, i) => <div key={i} className='flex items-center gap-1'>
					<input
						className='flex-1 min-w-0 px-1.5 py-0.5 text-sm rounded-[6px] border border-ze-border-2 bg-ze-bg-1 text-ze-fg-1'
						aria-label={`Step ${i + 1}`}
						value={s.text}
						onChange={e => update(i, e.target.value)}
					/>
					<button type='button' className={iconButton} title='Move up' aria-label='Move up' disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
					<button type='button' className={iconButton} title='Move down' aria-label='Move down' disabled={i === draft.length - 1} onClick={() => move(i, 1)}>↓</button>
					<button type='button' className={iconButton} title='Remove' aria-label='Remove' onClick={() => remove(i)}>×</button>
				</div>)}
			</div>
			<div>
				<button type='button' className='text-xs text-ze-accent hover:underline cursor-pointer' onClick={() => setDraft(d => d && [...d, { text: '', status: 'todo' }])}>＋ Add step</button>
			</div>
			<div className='flex gap-1.5 justify-end'>
				<ApprovalButton onClick={() => setDraft(null)}>Cancel</ApprovalButton>
				<ApprovalButton primary onClick={save}>Done</ApprovalButton>
			</div>
		</> : <>
			<ol className='flex flex-col gap-0.5 m-0 p-0 list-none'>
				{plan.steps.map((s, i) => <li key={i} className='flex items-start gap-1.5 text-sm'>
					{s.status === 'done'
						? <span className='w-3 shrink-0 text-ze-ok'>✓</span>
						: s.status === 'current'
							? <span className='w-3 shrink-0 text-ze-accent'>●</span>
							: <span className='w-3 shrink-0 text-ze-fg-3'>○</span>}
					<span className={s.status === 'done' ? 'line-through text-ze-fg-3' : s.status === 'current' ? 'text-ze-fg-1' : 'text-ze-fg-2'}>{s.text}</span>
				</li>)}
			</ol>
			{canApprove && <div className='flex justify-end'>
				<ApprovalButton primary disabled={approving} onClick={approve}>Approve plan</ApprovalButton>
			</div>}
		</>}
	</div>;
};
