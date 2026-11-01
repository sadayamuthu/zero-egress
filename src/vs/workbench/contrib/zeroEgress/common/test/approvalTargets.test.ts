/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { approvalClickTarget, countAwaiting, ThreadWaitInfo, waitInfoOf } from '../approvalTargets.js';

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

	test('background threads wait per the agents service, docked ones per the stream', () => {
		const info = waitInfoOf(
			[{ id: 'd1', background: false }, { id: 'd2', background: false }, { id: 'b1', background: true }, { id: 'b2', background: true }, { id: 'b3', background: true }],
			new Set(['d1', 'b2']), // b2 streams awaiting_user but is not in the agents list (other workspace): ignored
			new Set(['b1']), // b1 waits after a restart, with no stream state
		);
		assert.deepStrictEqual(info.filter(i => i.awaitingUser).map(i => i.id), ['d1', 'b1']);
		assert.strictEqual(countAwaiting(info), 2);
		assert.deepStrictEqual(approvalClickTarget(info), { kind: 'agents' });
	});
});
