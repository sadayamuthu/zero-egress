/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Diff } from './editCodeServiceTypes.js';

/**
 * The pending change covering a (1-indexed) line. The editor draws a deletion's removed lines between
 * startLine - 1 and startLine; at the end of the file startLine is one past the last line, so there the
 * deletion belongs to the last line instead.
 */
export function diffAtLine(diffs: readonly Diff[], line: number, lineCount: number): Diff | undefined {
	return [...diffs]
		.sort((a, b) => a.startLine - b.startLine)
		.find(d => d.type === 'deletion'
			? line === Math.min(d.startLine, lineCount)
			: d.startLine <= line && line <= d.endLine);
}
