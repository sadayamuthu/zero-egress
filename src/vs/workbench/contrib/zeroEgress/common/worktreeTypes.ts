/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const WORKTREE_CHANNEL = 'zero-egress-channel-worktree';

/** `subdir` is `''` or a path relative to `repoRoot` using `/`. */
export interface RepoInfo { repoRoot: string; subdir: string }

export interface CreatedWorktree { worktreePath: string; branch: string; baseCommit: string }

/** `path` is relative to the repo root and uses `/`. */
export interface ChangedFile { path: string; status: 'A' | 'M' | 'D'; binary: boolean }

export interface IZeroEgressWorktreeService {
	readonly _serviceBrand: undefined;
	/** The git repo containing `folder`, or `null` when it is not inside one. */
	repoInfo(folder: string): Promise<RepoInfo | null>;
	/** Creates `<userData>/agent-worktrees/<agentId>` on branch `ze/agent-<agentId>`, with the user's uncommitted changes committed as `ze: base`. */
	create(repoRoot: string, agentId: string): Promise<CreatedWorktree>;
	/** Runs a user-configured command with a shell. `exitCode` is `null` on timeout or spawn failure. `outputTail` is the last 4000 characters. */
	runSetup(cwd: string, command: string, timeoutMs: number): Promise<{ exitCode: number | null; outputTail: string }>;
	/** Files that differ from `baseCommit` under `subdir` (all files when `subdir` is `''`). */
	changedFiles(worktreePath: string, baseCommit: string, subdir: string): Promise<ChangedFile[]>;
	/** The base text of `path`: a `writeBase` override if any, else the content at `baseCommit`; `null` when it does not exist. */
	readBase(agentId: string, worktreePath: string, baseCommit: string, path: string): Promise<string | null>;
	/** Overrides the base text of `path` (`null` = the file does not exist at base). */
	writeBase(agentId: string, path: string, content: string | null): Promise<void>;
	/** Accepts or rejects an agent's change to a binary file. */
	resolveBinary(agentId: string, worktreePath: string, baseCommit: string, path: string, behavior: 'accept' | 'reject'): Promise<void>;
	/**
	 * Whether the user's file at `userFilePath` still has the bytes the agent started from for binary `path`: the bytes
	 * recorded by the last binary accept if any, else the content at `baseCommit`. Absent there means the user's file must not exist.
	 */
	userFileMatchesBase(agentId: string, worktreePath: string, baseCommit: string, path: string, userFilePath: string): Promise<boolean>;
	/**
	 * Throws `Path is outside this agent's worktree: <file>` unless the real path of `file`'s nearest existing ancestor (symlinks
	 * resolved) is inside the real path of `<worktreePath>/<subdir>`. `file` is absolute.
	 */
	checkAgentPath(worktreePath: string, subdir: string, file: string): Promise<void>;
	/** Removes the agent's worktree, branch and base overrides. Tolerates any of them being gone already. */
	remove(repoRoot: string, agentId: string): Promise<void>;
	/** Removes this repo's agent worktrees and branches whose id is not in `keepAgentIds`. */
	prune(repoRoot: string, keepAgentIds: string[]): Promise<void>;
}

export const IZeroEgressWorktreeService = createDecorator<IZeroEgressWorktreeService>('zeroEgressWorktreeService');
