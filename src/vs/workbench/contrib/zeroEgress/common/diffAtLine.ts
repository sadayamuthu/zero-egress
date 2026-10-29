/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Diff } from './editCodeServiceTypes.js';

/**
 * The pending change covering a (1-indexed) line. The editor draws a deletion's removed lines between
 * startLine - 1 and startLine (startLine can be one past the last line), so a deletion covers both.
 */
export function diffAtLine(diffs: readonly Diff[], line: number): Diff | undefined {
	return [...diffs]
		.sort((a, b) => a.startLine - b.startLine)
		.find(d => d.type === 'deletion'
			? line === d.startLine || line === d.startLine - 1
			: d.startLine <= line && line <= d.endLine);
}
