/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type PlanStatus = 'done' | 'current' | 'todo'
export type PlanStep = { text: string; status: PlanStatus }
export type ThreadPlan = { steps: PlanStep[]; updatedAt: string; madeInPlanMode: boolean; approvedAt?: string; editedAt?: string }

const MAX_STEP_TEXT = 200

/** one step per non-empty line; an optional leading `-`, `*` or `1.` is stripped, then `[x]`, `[>]` or `[ ]` */
export function parsePlan(raw: string): PlanStep[] {
	const steps: PlanStep[] = []
	let hasCurrent = false
	for (const line of raw.split(/\r?\n/)) {
		let rest = line.trim()
		if (!rest) continue
		rest = rest.replace(/^(?:[-*]|\d+[.)])\s+/, '')
		let status: PlanStatus = 'todo'
		const marker = /^\[([xX>\s])\]\s*/.exec(rest)
		if (marker) {
			rest = rest.slice(marker[0].length)
			const m = marker[1]
			if (m === 'x' || m === 'X') status = 'done'
			else if (m === '>') status = 'current'
		}
		const text = Array.from(rest.trim()).slice(0, MAX_STEP_TEXT).join('')
		if (!text) continue
		if (status === 'current') {
			if (hasCurrent) status = 'todo'
			else hasCurrent = true
		}
		steps.push({ text, status })
	}
	return steps
}

export function formatPlan(steps: PlanStep[]): string {
	return steps.map(s => `${s.status === 'done' ? '[x]' : s.status === 'current' ? '[>]' : '[ ]'} ${s.text}`).join('\n')
}

export function planProgress(steps: PlanStep[]): { done: number; total: number } {
	return { done: steps.filter(s => s.status === 'done').length, total: steps.length }
}

/** The plan after a write by the agent. A plan-mode write needs approval again; an agent-mode write keeps an earlier approval. */
export function nextPlan(prev: ThreadPlan | undefined, steps: PlanStep[], madeInPlanMode: boolean, now: string): ThreadPlan {
	if (madeInPlanMode) return { steps, updatedAt: now, madeInPlanMode: true }
	return { steps, updatedAt: now, madeInPlanMode: prev?.madeInPlanMode ?? false, approvedAt: prev?.approvedAt }
}
