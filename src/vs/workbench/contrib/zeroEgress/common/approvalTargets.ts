/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export interface ThreadWaitInfo {
	id: string;
	awaitingUser: boolean;
	/** true for a background agent thread, false for a chat that can be docked */
	background: boolean;
}

/** what a click on the "N agents need your OK" entry does */
export type ApprovalClickTarget =
	| { kind: 'chat'; threadId: string } // every waiting thread is docked: focus the chat panel on the first one
	| { kind: 'agents' }; // some waiting thread is a background agent (or none waits): open the Agents view

/** every thread, docked or background, that waits on the user */
export const countAwaiting = (threads: readonly ThreadWaitInfo[]): number =>
	threads.filter(t => t.awaitingUser).length;

export const approvalClickTarget = (threads: readonly ThreadWaitInfo[]): ApprovalClickTarget => {
	const waiting = threads.filter(t => t.awaitingUser);
	if (waiting.length === 0 || waiting.some(t => t.background)) { return { kind: 'agents' }; }
	return { kind: 'chat', threadId: waiting[0].id };
};

/**
 * Builds the wait info for every thread. A background thread waits when the agents service says `needs_ok` for it (that
 * source also covers agents left waiting after a restart and skips other workspaces); a docked thread waits when its
 * stream state is `awaiting_user`.
 */
export const waitInfoOf = (
	threads: readonly { id: string; background: boolean }[],
	streamAwaiting: ReadonlySet<string>,
	agentsNeedingOk: ReadonlySet<string>,
): ThreadWaitInfo[] => threads.map(t => ({
	id: t.id,
	background: t.background,
	awaitingUser: t.background ? agentsNeedingOk.has(t.id) : streamAwaiting.has(t.id),
}));
