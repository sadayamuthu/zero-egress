/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Home screen helpers: matching a recent folder to the agents' `userRoot`, and the review label.

/** trailing separators dropped (a root such as `/` or `C:\` keeps its own); lower-cased when `caseInsensitive` */
export const folderKey = (fsPath: string, caseInsensitive: boolean): string => {
	let p = fsPath;
	while (p.length > 1 && /[\\/]$/.test(p) && !/^[a-zA-Z]:[\\/]$/.test(p)) {
		p = p.slice(0, -1);
	}
	return caseInsensitive ? p.toLowerCase() : p;
};

/** re-keys `countsByUserRoot` with `folderKey`, adding counts whose keys collide */
export const countsByFolderKey = (countsByUserRoot: ReadonlyMap<string, number>, caseInsensitive: boolean): Map<string, number> => {
	const out = new Map<string, number>();
	for (const [root, n] of countsByUserRoot) {
		const key = folderKey(root, caseInsensitive);
		out.set(key, (out.get(key) ?? 0) + n);
	}
	return out;
};

/** `1 agent needs review`, `N agents need review`; empty when N is 0 */
export const reviewLabel = (n: number): string =>
	n <= 0 ? '' : n === 1 ? '1 agent needs review' : `${n} agents need review`;
