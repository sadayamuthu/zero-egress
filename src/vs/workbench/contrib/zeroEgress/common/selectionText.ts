/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { StagingSelectionItem } from './chatThreadServiceTypes.js';

export const TERMINAL_MAX_CHARS = 20_000;
export const DIFF_MAX_CHARS = 60_000;
export const PROBLEMS_MAX = 100;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const FENCE = '```';

/** keeps the last `max` chars */
export function capTail(text: string, max: number): string {
	return text.length > max ? text.slice(text.length - max) : text;
}

/** keeps the first `max` chars */
export function capHead(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) : text;
}

/** the prompt text of a snapshot selection; '' for any other type */
export function textOfSnapshotSelection(s: StagingSelectionItem): string {
	if (s.type === 'Terminal') {
		return `Terminal output (${s.title}):\n${FENCE}\n${capTail(s.text, TERMINAL_MAX_CHARS)}\n${FENCE}`;
	}
	if (s.type === 'Problems') {
		return 'Problems:\n' + s.items.slice(0, PROBLEMS_MAX)
			.map(p => `${p.path}:${p.line} ${p.severity}: ${p.message}`).join('\n');
	}
	if (s.type === 'GitDiff') {
		const what = s.against === null ? 'working changes' : 'against ' + s.against;
		const truncated = s.truncated || s.text.length > DIFF_MAX_CHARS;
		return `Git diff (${what})${truncated ? ' (truncated)' : ''}:\n${FENCE}diff\n${capHead(s.text, DIFF_MAX_CHARS)}\n${FENCE}`;
	}
	if (s.type === 'Symbol') {
		return `Symbol ${s.name} (${s.kind}) in ${s.uri.fsPath} (lines ${s.range[0]}:${s.range[1]}):`;
	}
	return '';
}
