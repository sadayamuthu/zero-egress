/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveAgentPath } from '../agentPaths.js';

(isWindows ? suite.skip : suite)('agentPaths', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const roots = { agentRoot: '/data/wt/ab12cd34/pkg', userRoot: '/repo/pkg' };

	test('inside agent root passes', () => {
		assert.strictEqual(resolveAgentPath('/data/wt/ab12cd34/pkg/a.ts', roots), '/data/wt/ab12cd34/pkg/a.ts');
	});

	test('user root is remapped', () => {
		assert.strictEqual(resolveAgentPath('/repo/pkg/src/a.ts', roots), '/data/wt/ab12cd34/pkg/src/a.ts');
	});

	test('escapes via .. are refused', () => {
		assert.throws(() => resolveAgentPath('/data/wt/ab12cd34/pkg/../../x', roots), (e: Error) => e.message === `Path is outside this agent's worktree: /data/wt/ab12cd34/pkg/../../x`);
	});

	test('sibling prefix is refused', () => {
		assert.throws(() => resolveAgentPath('/data/wt/ab12cd34/pkg2/a.ts', roots), /Path is outside this agent's worktree: /);
	});

	test('other absolute path is refused', () => {
		assert.throws(() => resolveAgentPath('/etc/hosts', roots), /Path is outside this agent's worktree: \/etc\/hosts/);
	});

	test('.git path segments are refused', () => {
		for (const p of ['/data/wt/ab12cd34/pkg/.git', '/data/wt/ab12cd34/pkg/.git/config', '/repo/pkg/sub/.git/hooks/pre-commit', '.git/HEAD', 'sub/.GIT/x']) {
			assert.throws(() => resolveAgentPath(p, roots), (e: Error) => e.message === `Path is outside this agent's worktree: ${p}`, p);
		}
		assert.strictEqual(resolveAgentPath('/repo/pkg/.github/workflows/ci.yml', roots), '/data/wt/ab12cd34/pkg/.github/workflows/ci.yml');
		assert.strictEqual(resolveAgentPath('/repo/pkg/a.git', roots), '/data/wt/ab12cd34/pkg/a.git');
	});
});
