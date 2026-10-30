/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The background agents service's interface, apart from its implementation so React views can import it without
// pulling in chatThreadService (an import cycle through the React bundles).

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { FileReview, HunkState } from '../common/agentReview.js';
import { AgentStatus } from '../common/agentStatus.js';

export const BACKGROUND_AGENTS_UNAVAILABLE = 'Background agents need a single folder inside a git repository.';
export const FILE_CONFLICT_ACCEPT_TOOLTIP = 'You changed this file too. Resolve it in the editor, then refresh.';

export interface AgentSummary { threadId: string; title: string; status: AgentStatus; changedFiles: number }

export interface IBackgroundAgentsService {
	readonly _serviceBrand: undefined;
	/** background agents of the current workspace folder, newest first */
	readonly agents: readonly AgentSummary[];
	readonly onDidChange: Event<void>;
	availability(): Promise<{ ok: true } | { ok: false; reason: string }>;
	/** returns the new thread's id */
	startAgent(prompt: string, fromThreadId?: string): Promise<string>;
	deleteAgent(threadId: string): Promise<void>;
	/** pending files only (a file whose changes were all accepted or rejected is left out) */
	getReview(threadId: string): Promise<FileReview[]>;
	/** `rendered` is the hunk the UI showed; if the fresh review has no identical hunk (already handled, or the user's text changed), nothing happens */
	acceptHunk(threadId: string, path: string, rendered: HunkState): Promise<void>;
	/** `rendered` is the hunk the UI showed; if the fresh review has no identical hunk, nothing happens */
	rejectHunk(threadId: string, path: string, rendered: HunkState): Promise<void>;
	acceptFile(threadId: string, path: string): Promise<void>;
	rejectFile(threadId: string, path: string): Promise<void>;
	/** clean hunks and whole-file changes only; conflicts stay pending */
	acceptAll(threadId: string): Promise<void>;
	/** clean hunks and whole-file changes only; conflicts stay pending */
	rejectAll(threadId: string): Promise<void>;
	/**
	 * For every folder that has background agents (any window, keyed by `agent.userRoot`): how many of its agents have at
	 * least one pending file. Agents whose worktree was removed are skipped; one that can't be read counts 0. Never throws.
	 */
	pendingReviewCountsByFolder(): Promise<Map<string, number>>;
}

export const IBackgroundAgentsService = createDecorator<IBackgroundAgentsService>('zeroEgressBackgroundAgentsService');
