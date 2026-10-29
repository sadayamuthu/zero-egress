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

/**
 * Confines a path to a background agent's root. Paths under the agent root pass (normalized),
 * paths under the user's folder are remapped to the same relative path in the agent root,
 * anything else throws. This is a path check, not an OS sandbox.
 */
export function resolveAgentPath(path: string, roots: { agentRoot: string; userRoot: string }): string {
	const lib = pathLib()
	const agentRoot = stripTrailingSep(lib.normalize(roots.agentRoot))
	const userRoot = stripTrailingSep(lib.normalize(roots.userRoot))
	const p = stripTrailingSep(lib.resolve(agentRoot, path))

	if (isUnder(p, agentRoot)) return p
	if (isUnder(p, userRoot)) {
		const rel = lib.relative(userRoot, p)
		return rel ? lib.join(agentRoot, rel) : agentRoot
	}
	throw new Error(`Path is outside this agent's worktree: ${path}`)
}
