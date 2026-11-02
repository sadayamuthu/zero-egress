/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The pure parts of adding untracked files to the working-changes diff (/review, /commit, @ Git diff).

import { isAbsolute, relative, resolve } from '../../../../base/common/path.js';

/** names from `git … -z` output; when the output was cut off (`complete` false) the last, partial name is dropped */
export function parseNulList(out: string, complete: boolean): string[] {
	const parts = out.split('\0');
	const last = parts.pop(); // '' after a trailing NUL, else a name that was cut off or not terminated
	if (complete && last) { parts.push(last); }
	return parts.filter(p => p.length > 0);
}

/** whether `file` (relative to `root`, or absolute) is strictly inside `root` */
export function isInsideRoot(root: string, file: string): boolean {
	const rel = relative(resolve(root), resolve(root, file));
	return rel.length > 0 && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + '/') && !rel.startsWith('..' + '\\');
}

/** `git diff --no-index` exits 1 when the two sides differ, which for /dev/null against a file is the normal case */
export function noIndexDiffOk(code: number | null): boolean {
	return code === 0 || code === 1;
}

/** a diff with only whitespace means there are no changes */
export function hasDiffText(text: string): boolean {
	return text.trim().length > 0;
}
