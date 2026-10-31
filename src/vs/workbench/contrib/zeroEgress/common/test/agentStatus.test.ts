/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentStatus } from '../agentStatus.js';

suite('agentStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('LLM / tool / idle -> Running', () => {
		for (const isRunning of ['LLM', 'tool', 'idle'] as const) {
			assert.deepStrictEqual(agentStatus({ isRunning, hasError: false, pendingFiles: 2 }), { kind: 'running', label: 'Running' });
		}
	});

	test('waiting_for_model -> Waiting for model', () => {
		assert.deepStrictEqual(agentStatus({ isRunning: 'waiting_for_model', hasError: false, pendingFiles: 0 }), { kind: 'waiting', label: 'Waiting for model' });
	});

	test('awaiting_user -> Needs your OK', () => {
		assert.deepStrictEqual(agentStatus({ isRunning: 'awaiting_user', hasError: false, pendingFiles: 1 }), { kind: 'needs_ok', label: 'Needs your OK' });
	});

	test('not running with pending files -> Needs review (N)', () => {
		assert.deepStrictEqual(agentStatus({ isRunning: undefined, hasError: false, pendingFiles: 3 }), { kind: 'needs_review', label: 'Needs review (3)' });
	});

	test('not running with an error -> Failed', () => {
		assert.deepStrictEqual(agentStatus({ isRunning: undefined, hasError: true, pendingFiles: 0 }), { kind: 'failed', label: 'Failed' });
	});

	test('not running with nothing pending -> Done', () => {
		assert.deepStrictEqual(agentStatus({ isRunning: undefined, hasError: false, pendingFiles: 0 }), { kind: 'done', label: 'Done' });
	});
});
