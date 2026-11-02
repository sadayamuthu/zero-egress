/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ChatMessage } from './chatThreadServiceTypes.js'

export type PlanStatus = 'done' | 'current' | 'todo'
export type PlanStep = { text: string; status: PlanStatus }
export type ThreadPlan = { steps: PlanStep[]; updatedAt: string; madeInPlanMode: boolean; approvedAt?: string; editedAt?: string }

const MAX_STEP_TEXT = 200

/** one step per non-empty line; an optional leading `-`, `*` or `1.` is stripped, then `[x]`, `[>]` or `[ ]` */
export function parsePlan(raw: string): PlanStep[] {
	const arr = jsonArrayOf(raw)
	if (arr) return parseItems(arr)
	return parseItems(raw.split(/\r?\n/))
}

const jsonArrayOf = (raw: string): unknown[] | undefined => {
	const t = raw.trim()
	if (!t.startsWith('[')) return undefined
	try {
		const v = JSON.parse(t)
		return Array.isArray(v) ? v : undefined
	} catch { return undefined }
}

const statusOfWord = (w: unknown): PlanStatus => {
	const k = typeof w === 'string' ? w.trim().toLowerCase() : ''
	if (k === 'done' || k === 'completed') return 'done'
	if (k === 'current' || k === 'in_progress' || k === 'doing') return 'current'
	return 'todo'
}

/** items are lines of text, or (from a JSON list) objects `{text|step|title, status?}` */
function parseItems(items: unknown[]): PlanStep[] {
	const steps: PlanStep[] = []
	let hasCurrent = false
	for (const item of items) {
		let line = ''
		let forced: PlanStatus | undefined
		if (typeof item === 'string') line = item
		else if (item && typeof item === 'object') {
			const o = item as Record<string, unknown>
			const t = [o.text, o.step, o.title].find(v => typeof v === 'string')
			if (typeof t !== 'string') continue
			line = t
			forced = statusOfWord(o.status)
		}
		let rest = line.trim()
		if (!rest) continue
		rest = rest.replace(/^(?:[-*]|\d+[.)])\s+/, '')
		let status: PlanStatus = forced ?? 'todo'
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

/** the plan that survives a cut (restore, edit) leaving `messages`: none once no successful update_plan call remains */
export function planAfterCut(messages: ChatMessage[], plan: ThreadPlan | undefined): ThreadPlan | undefined {
	if (!plan) return undefined
	return messages.some(m => m.role === 'tool' && m.name === 'update_plan' && m.type === 'success') ? plan : undefined
}

/** the plan steps shown to the model: only runs that may write the plan (Agent, Plan, editing custom modes) see it */
export function planForPrompt(plan: ThreadPlan | undefined, toolPolicy: { plan: boolean } | null): PlanStep[] | undefined {
	return plan && toolPolicy?.plan ? plan.steps : undefined
}
