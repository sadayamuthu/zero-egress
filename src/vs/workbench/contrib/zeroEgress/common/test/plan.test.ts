/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatPlan, nextPlan, parsePlan, planProgress, PlanStep, ThreadPlan } from '../plan.js';

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

	test('handles CRLF and blank lines', () => {
		assert.deepStrictEqual(parsePlan('[x] a\r\n\r\n  \n[ ] b\r\n').map(s => s.text), ['a', 'b']);
	});

	test('cuts long lines to 200', () => {
		assert.strictEqual(parsePlan('[ ] ' + 'a'.repeat(300))[0].text.length, 200);
	});

	test('a bare marker is skipped and keeps the current slot', () => {
		const steps = parsePlan('[>]\n[>] real');
		assert.deepStrictEqual(steps, [{ text: 'real', status: 'current' }]);
	});

	test('strips 1) list marks', () => {
		assert.deepStrictEqual(parsePlan('1) [x] a\n2) b').map(s => s.text), ['a', 'b']);
	});

	test('cuts at code points', () => {
		const text = parsePlan('a'.repeat(199) + '😀' + 'b')[0].text;
		assert.strictEqual(Array.from(text).length, 200);
		assert.ok(text.endsWith('😀'));
	});

	const steps: PlanStep[] = [{ text: 'a', status: 'todo' }];
	const approved: ThreadPlan = { steps, updatedAt: 't0', madeInPlanMode: true, approvedAt: 't1', editedAt: 't2' };

	test('a plan-mode write after approval clears approvedAt', () => {
		const n = nextPlan(approved, steps, true, 't3');
		assert.strictEqual(n.approvedAt, undefined);
		assert.strictEqual(n.editedAt, undefined);
		assert.strictEqual(n.madeInPlanMode, true);
		assert.strictEqual(n.updatedAt, 't3');
	});

	test('an agent-mode write after approval keeps approvedAt and madeInPlanMode', () => {
		const n = nextPlan(approved, steps, false, 't3');
		assert.strictEqual(n.approvedAt, 't1');
		assert.strictEqual(n.madeInPlanMode, true);
		assert.strictEqual(n.editedAt, undefined);
	});

	test('a first agent-mode write is not plan mode', () => {
		const n = nextPlan(undefined, steps, false, 't3');
		assert.strictEqual(n.madeInPlanMode, false);
		assert.strictEqual(n.approvedAt, undefined);
	});
});
