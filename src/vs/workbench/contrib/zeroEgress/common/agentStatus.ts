/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** what a thread's run is doing right now (`IsRunningType` in the chat thread service is this type) */
export type RunPhase =
	| 'LLM' // the LLM is currently streaming
	| 'tool' // a tool is currently running
	| 'awaiting_user' // waiting for the user to approve a tool
	| 'idle' // nothing is running now, but the chat should still appear like it's going (used in-between calls)
	| 'waiting_for_model' // queued for a model slot (the provider's parallel requests are all busy)
	| undefined

export type AgentStatus = { kind: 'running' | 'waiting' | 'needs_ok' | 'needs_review' | 'done' | 'failed'; label: string }

export function agentStatus(s: { isRunning: RunPhase; hasError: boolean; pendingFiles: number }): AgentStatus {
	switch (s.isRunning) {
		case 'LLM':
		case 'tool':
		case 'idle':
			return { kind: 'running', label: 'Running' };
		case 'waiting_for_model':
			return { kind: 'waiting', label: 'Waiting for model' };
		case 'awaiting_user':
			return { kind: 'needs_ok', label: 'Needs your OK' };
	}
	if (s.hasError) { return { kind: 'failed', label: 'Failed' }; }
	if (s.pendingFiles > 0) { return { kind: 'needs_review', label: `Needs review (${s.pendingFiles})` }; }
	return { kind: 'done', label: 'Done' };
}
