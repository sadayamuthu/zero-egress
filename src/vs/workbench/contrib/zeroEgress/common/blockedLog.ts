/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The "ZeroEgress: Network" log lines. A caller stuck in a retry loop would otherwise write one line (and the
// renderer one Output append) per attempt, so repeats of the same destination from the same caller are
// coalesced: the first attempt of a window is written at once, later ones in that window are counted, and one
// summary line is written when the window ends.

import { BlockedAttempt } from './egressGuardService.js';
import { describeDestination } from './egressPolicy.js';

export function formatBlockedAttempt(e: BlockedAttempt): string {
	return `${new Date(e.time).toISOString()} blocked ${describeDestination(e.url)} (caller: ${e.origin})\n`;
}

export const BLOCKED_LOG_WINDOW_MS = 60_000;

export class BlockedLogCoalescer {
	private readonly open = new Map<string, { first: BlockedAttempt; repeats: number }>();

	constructor(private readonly windowMs = BLOCKED_LOG_WINDOW_MS) { }

	/** The lines to write now for `e`: summaries of windows that ended before it, then `e` itself if it opens a window. */
	add(e: BlockedAttempt): string[] {
		const lines = this.flush(e.time);
		const key = `${describeDestination(e.url)}\u0000${e.origin}`;
		const entry = this.open.get(key);
		if (entry) {
			entry.repeats++;
		} else {
			this.open.set(key, { first: e, repeats: 0 });
			lines.push(formatBlockedAttempt(e));
		}
		return lines;
	}

	/** Closes every window that ended by `now`; returns a summary line for each that had repeats. */
	flush(now: number): string[] {
		const lines: string[] = [];
		for (const [key, { first, repeats }] of this.open) {
			if (now - first.time < this.windowMs) { continue; }
			this.open.delete(key);
			if (repeats > 0) {
				const end = new Date(first.time + this.windowMs).toISOString();
				lines.push(`${end} blocked ${describeDestination(first.url)} (caller: ${first.origin}) ${repeats} more ${repeats === 1 ? 'time' : 'times'} in the ${this.windowMs / 1000} s after the line above for it\n`);
			}
		}
		return lines;
	}
}
