/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Which pending changes one docked chat reviews (its review bar, Accept all, Reject all, ⌘⏎) and which files its
// Restore may overwrite. Pure: the caller supplies the owners (IChangeOwnersService). A file with no owner (or whose
// owner chat is gone, which the caller maps to undefined) is another chat's: it shows as "from other chats".

export interface FilePending {
	path: string;
	owner: string | undefined;
	/** the diff count, plus 1 for a pending create or delete */
	changes: number;
}

export function reviewScope<T extends FilePending>(files: T[], threadId: string): { mine: T[]; changes: number; otherFiles: number } {
	const mine = files.filter(f => f.owner === threadId);
	return {
		mine,
		changes: mine.reduce((n, f) => n + f.changes, 0),
		otherFiles: files.length - mine.length,
	};
}

/** Restore skips a file another chat has pending changes in; a file no one has pending (or that is mine) is restored. */
export function restoreTargets(
	paths: string[],
	ownerOf: (p: string) => string | undefined,
	hasPending: (p: string) => boolean,
	threadId: string,
): { restore: string[]; skipped: string[] } {
	const restore: string[] = [];
	const skipped: string[] = [];
	for (const p of paths) {
		const owner = ownerOf(p);
		if (owner !== undefined && owner !== threadId && hasPending(p)) {
			skipped.push(p);
		} else {
			restore.push(p);
		}
	}
	return { restore, skipped };
}
