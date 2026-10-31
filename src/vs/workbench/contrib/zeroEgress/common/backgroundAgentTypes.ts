/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { join } from '../../../../base/common/path.js';

/** Stored on a chat thread that runs as a background agent in its own git worktree. Plain JSON (persisted with the thread). */
export interface BackgroundAgentInfo {
	agentId: string;
	/** top of the user's git repo */
	repoRoot: string;
	/** the user's folder relative to repoRoot ('' when the folder is the repo root) */
	subdir: string;
	/** the user's workspace folder */
	userRoot: string;
	/** '' once the worktree has been removed */
	worktreePath: string;
	branch: string;
	baseCommit: string;
	setup: { command: string; exitCode: number | null; outputTail: string } | null;
}

export const agentRootOf = (a: BackgroundAgentInfo) => a.subdir ? join(a.worktreePath, a.subdir) : a.worktreePath

export type ToolRunContext = { kind: 'docked' } | { kind: 'background'; agent: BackgroundAgentInfo }

export const AGENT_WORKTREE_REMOVED_MESSAGE = `This agent's worktree was removed.`
