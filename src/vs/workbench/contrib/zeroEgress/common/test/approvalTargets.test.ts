/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { approvalClickTarget, countAwaiting, ThreadWaitInfo } from '../approvalTargets.js';

suite('approvalTargets', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const t = (id: string, awaitingUser: boolean, background = false): ThreadWaitInfo => ({ id, awaitingUser, background });

	test('counts docked and background threads that wait', () => {
		assert.strictEqual(countAwaiting([t('a', true), t('b', true, true), t('c', false)]), 2);
		assert.strictEqual(countAwaiting([]), 0);
	});

	test('all docked: focus the first waiting chat', () => {
		assert.deepStrictEqual(approvalClickTarget([t('a', false), t('b', true), t('c', true)]), { kind: 'chat', threadId: 'b' });
	});

	test('any background waiting thread opens the Agents view', () => {
		assert.deepStrictEqual(approvalClickTarget([t('a', true), t('b', true, true)]), { kind: 'agents' });
	});

	test('nothing waiting opens the Agents view', () => {
		assert.deepStrictEqual(approvalClickTarget([t('a', false)]), { kind: 'agents' });
	});
});
