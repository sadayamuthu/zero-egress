/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { posix, win32 } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';

const pathLib = () => isWindows ? win32 : posix

const stripTrailingSep = (p: string) => {
	const { sep, parse } = pathLib()
	return p.length > parse(p).root.length && p.endsWith(sep) ? p.slice(0, -1) : p
}

const isUnder = (p: string, root: string) => {
	const { sep } = pathLib()
	const a = isWindows ? p.toLowerCase() : p
	const b = isWindows ? root.toLowerCase() : root
	return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** `p` is `root` or under it; true when a segment below `root` is `.git` (any case: macOS and Windows ignore it) */
const hasGitSegment = (p: string, root: string) => {
	const lib = pathLib()
	return lib.relative(root, p).split(/[\\/]/).some(s => s.toLowerCase() === '.git')
}

/**
 * Confines a path to a background agent's root. Paths under the agent root pass (normalized),
 * paths under the user's folder are remapped to the same relative path in the agent root,
 * anything else throws. A `.git` segment throws too: git's own files are not the agent's to edit. This is a path check
 * (symlinks are checked separately, before writes), not an OS sandbox.
 */
export function resolveAgentPath(path: string, roots: { agentRoot: string; userRoot: string }): string {
	const lib = pathLib()
	const agentRoot = stripTrailingSep(lib.normalize(roots.agentRoot))
	const userRoot = stripTrailingSep(lib.normalize(roots.userRoot))
	const p = stripTrailingSep(lib.resolve(agentRoot, path))

	const outside = () => new Error(`Path is outside this agent's worktree: ${path}`)

	if (isUnder(p, agentRoot)) {
		if (hasGitSegment(p, agentRoot)) throw outside()
		return p
	}
	if (isUnder(p, userRoot)) {
		const rel = lib.relative(userRoot, p)
		const mapped = rel ? lib.join(agentRoot, rel) : agentRoot
		if (hasGitSegment(mapped, agentRoot)) throw outside()
		return mapped
	}
	throw outside()
}
