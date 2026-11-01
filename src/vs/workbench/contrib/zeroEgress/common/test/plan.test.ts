/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatPlan, parsePlan, planProgress, PlanStep } from '../plan.js';

suite('plan', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses markers', () => {
		assert.deepStrictEqual(parsePlan('[x] Read auth.ts\n[>] Wire it\n[ ] Add test'), [
			{ text: 'Read auth.ts', status: 'done' },
			{ text: 'Wire it', status: 'current' },
			{ text: 'Add test', status: 'todo' },
		]);
	});

	test('strips list marks', () => {
		assert.deepStrictEqual(parsePlan('- [x] a\n2. [ ] b').map(s => s.text), ['a', 'b']);
	});

	test('one current', () => {
		assert.deepStrictEqual(parsePlan('[>] a\n[>] b').map(s => s.status), ['current', 'todo']);
	});

	test('round trip', () => {
		const s: PlanStep[] = [{ text: 'a', status: 'done' }, { text: 'b', status: 'current' }, { text: 'c', status: 'todo' }];
		assert.deepStrictEqual(parsePlan(formatPlan(s)), s);
	});

	test('progress', () => {
		const s: PlanStep[] = [{ text: 'a', status: 'done' }, { text: 'b', status: 'current' }, { text: 'c', status: 'todo' }];
		assert.deepStrictEqual(planProgress(s), { done: 1, total: 3 });
	});
});
