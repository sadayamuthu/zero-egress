/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The chat's plan as a live card: `Plan · d of n` with a row per step (done struck through, current in the accent
// color, todo muted). Edit turns the rows into inputs (reorder, add, remove) and Done saves them through the chat
// service; Approve plan shows for a plan written in Plan mode until it is approved, while the chat is idle.

import React, { useEffect, useRef, useState } from 'react';
import { useAccessor, useChatThreadsState, useChatThreadsStreamState } from '../../util/services.js';
import { planProgress } from '../composerDeps.js';
import type { PlanStep } from '../composerDeps.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { ApprovalButton } from './ApprovalCard.js';

type DraftStep = { id: number; text: string; status: PlanStep['status'] };
type Draft = { steps: DraftStep[]; baseUpdatedAt: string };
type FocusTarget = { id: number; part: 'input' | 'up' | 'down' };

export const PlanCard = ({ threadId }: { threadId: string }) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const plan = useChatThreadsState().allThreads[threadId]?.plan;
	const streamState = useChatThreadsStreamState(threadId);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [emptyNote, setEmptyNote] = useState(false);
	const [approving, setApproving] = useState(false);
	const nextId = useRef(1);
	const pendingFocus = useRef<FocusTarget | null>(null);
	const fieldRefs = useRef(new Map<string, HTMLElement>());

	const isIdle = !streamState?.isRunning; // undefined when idle; 'awaiting_user' counts as busy
	const updatedAt = plan?.updatedAt;

	// a draft made against an older plan, or while the agent works, is dropped: the card returns to the current plan
	useEffect(() => {
		if (draft && (!isIdle || updatedAt !== draft.baseUpdatedAt)) {
			setDraft(null);
			setEmptyNote(false);
		}
	}, [draft, isIdle, updatedAt]);

	useEffect(() => {
		const target = pendingFocus.current;
		if (!target) { return; }
		pendingFocus.current = null;
		fieldRefs.current.get(`${target.id}:${target.part}`)?.focus();
	}, [draft]);

	if (!plan) {
		return null;
	}
	const { done, total } = planProgress(plan.steps);
	const canApprove = plan.madeInPlanMode && !plan.approvedAt && isIdle;
	const refOf = (id: number, part: FocusTarget['part']) => (el: HTMLElement | null) => {
		if (el) { fieldRefs.current.set(`${id}:${part}`, el); } else { fieldRefs.current.delete(`${id}:${part}`); }
	};
	const withSteps = (f: (steps: DraftStep[]) => DraftStep[]) => setDraft(d => d && { ...d, steps: f(d.steps) });

	const startEdit = () => {
		setEmptyNote(false);
		setDraft({ steps: plan.steps.map(s => ({ ...s, id: nextId.current++ })), baseUpdatedAt: plan.updatedAt });
	};
	const update = (id: number, text: string) => withSteps(steps => steps.map(s => s.id === id ? { ...s, text } : s));
	const move = (id: number, by: -1 | 1, part: 'up' | 'down') => {
		pendingFocus.current = { id, part };
		withSteps(steps => {
			const i = steps.findIndex(s => s.id === id);
			if (i < 0 || i + by < 0 || i + by >= steps.length) { return steps; }
			const next = [...steps];
			[next[i], next[i + by]] = [next[i + by], next[i]];
			return next;
		});
	};
	const remove = (id: number) => {
		if (draft) {
			const i = draft.steps.findIndex(s => s.id === id);
			const neighbor = draft.steps[i + 1] ?? draft.steps[i - 1];
			pendingFocus.current = neighbor ? { id: neighbor.id, part: 'input' } : null;
		}
		withSteps(steps => steps.filter(s => s.id !== id));
	};
	const add = () => {
		const id = nextId.current++;
		pendingFocus.current = { id, part: 'input' };
		withSteps(steps => [...steps, { id, text: '', status: 'todo' }]);
	};
	const save = () => {
		if (!draft) { return; }
		const steps = draft.steps.map(s => ({ text: s.text.trim(), status: s.status })).filter(s => s.text !== '');
		if (steps.length === 0) {
			setEmptyNote(true); // keep the previous steps and stay in edit mode
			return;
		}
		chatThreadsService.setPlanSteps(threadId, steps);
		setDraft(null);
		setEmptyNote(false);
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
			{!draft && isIdle && <button type='button' className='text-xs text-ze-accent hover:underline cursor-pointer' onClick={startEdit}>Edit</button>}
		</div>
		{draft ? <>
			<div className='flex flex-col gap-1'>
				{draft.steps.map((s, i) => <div key={s.id} className='flex items-center gap-1'>
					<input
						ref={refOf(s.id, 'input')}
						className='flex-1 min-w-0 px-1.5 py-0.5 text-sm rounded-[6px] border border-ze-border-2 bg-ze-bg-1 text-ze-fg-1'
						aria-label={`Step ${i + 1}`}
						value={s.text}
						onChange={e => update(s.id, e.target.value)}
					/>
					<button type='button' ref={refOf(s.id, 'up')} className='w-5 h-5 flex items-center justify-center rounded-[4px] text-ze-fg-3 hover:text-ze-fg-1 hover:bg-ze-bg-2-hover cursor-pointer disabled:opacity-30 disabled:cursor-default' title='Move up' aria-label='Move up' disabled={i === 0} onClick={() => move(s.id, -1, 'up')}>↑</button>
					<button type='button' ref={refOf(s.id, 'down')} className='w-5 h-5 flex items-center justify-center rounded-[4px] text-ze-fg-3 hover:text-ze-fg-1 hover:bg-ze-bg-2-hover cursor-pointer disabled:opacity-30 disabled:cursor-default' title='Move down' aria-label='Move down' disabled={i === draft.steps.length - 1} onClick={() => move(s.id, 1, 'down')}>↓</button>
					<button type='button' className='w-5 h-5 flex items-center justify-center rounded-[4px] text-ze-fg-3 hover:text-ze-fg-1 hover:bg-ze-bg-2-hover cursor-pointer disabled:opacity-30 disabled:cursor-default' title='Remove' aria-label='Remove' onClick={() => remove(s.id)}>×</button>
				</div>)}
			</div>
			<div>
				<button type='button' className='text-xs text-ze-accent hover:underline cursor-pointer' onClick={add}>＋ Add step</button>
			</div>
			{emptyNote && <div className='text-xs text-ze-warning' role='alert'>A plan needs at least one step.</div>}
			<div className='flex gap-1.5 justify-end'>
				<ApprovalButton onClick={() => { setDraft(null); setEmptyNote(false); }}>Cancel</ApprovalButton>
				<ApprovalButton primary onClick={save}>Done</ApprovalButton>
			</div>
		</> : <>
			<ol className='flex flex-col gap-0.5 m-0 p-0 list-none'>
				{plan.steps.map((s, i) => <li key={i} className='flex items-start gap-1.5 text-sm'>
					{s.status === 'done'
						? <span className='w-3 shrink-0 text-ze-ok' role='img' aria-label='done'>✓</span>
						: s.status === 'current'
							? <span className='w-3 shrink-0 text-ze-accent' role='img' aria-label='current'>●</span>
							: <span className='w-3 shrink-0 text-ze-fg-3' role='img' aria-label='to do'>○</span>}
					<span className={s.status === 'done' ? 'line-through text-ze-fg-3' : s.status === 'current' ? 'text-ze-fg-1' : 'text-ze-fg-2'}>{s.text}</span>
				</li>)}
			</ol>
			{canApprove && <div className='flex justify-end'>
				<ApprovalButton primary disabled={approving} onClick={approve}>Approve plan</ApprovalButton>
			</div>}
		</>}
	</div>;
};
