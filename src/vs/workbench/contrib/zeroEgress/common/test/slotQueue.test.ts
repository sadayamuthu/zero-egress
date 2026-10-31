/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SlotQueue } from '../slotQueue.js';

const flush = () => new Promise<void>(res => setTimeout(res, 0));

suite('SlotQueue', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const track = (p: Promise<IDisposable>, started: string[], name: string) => {
		const slot: { value?: IDisposable } = {};
		p.then(d => { slot.value = d; started.push(name); }, () => { });
		return slot;
	};

	test('limit is respected', async () => {
		const q = store.add(new SlotQueue());
		const started: string[] = [];
		const a = track(q.acquire('model:ollama', 2), started, 'a');
		const b = track(q.acquire('model:ollama', 2), started, 'b');
		const c = track(q.acquire('model:ollama', 2), started, 'c');
		await flush();
		assert.deepStrictEqual(started, ['a', 'b']);
		assert.strictEqual(q.active('model:ollama'), 2);
		assert.strictEqual(q.waiting('model:ollama'), 1);
		a.value!.dispose();
		await flush();
		assert.deepStrictEqual(started, ['a', 'b', 'c']);
		assert.strictEqual(q.waiting('model:ollama'), 0);
		b.value!.dispose(); c.value!.dispose();
		assert.strictEqual(q.active('model:ollama'), 0);
	});

	test('FIFO order', async () => {
		const q = store.add(new SlotQueue());
		const started: string[] = [];
		const first = track(q.acquire('agents', 1), started, 'first');
		const w = [1, 2, 3].map(i => track(q.acquire('agents', 1), started, `w${i}`));
		await flush();
		first.value!.dispose(); await flush();
		w[0].value!.dispose(); await flush();
		w[1].value!.dispose(); await flush();
		assert.deepStrictEqual(started, ['first', 'w1', 'w2', 'w3']);
		w[2].value!.dispose();
	});

	test('priority jumps the line', async () => {
		const q = store.add(new SlotQueue());
		const started: string[] = [];
		const first = track(q.acquire('model:ollama', 1), started, 'first');
		const bg1 = track(q.acquire('model:ollama', 1), started, 'bg1');
		const bg2 = track(q.acquire('model:ollama', 1), started, 'bg2');
		const docked = track(q.acquire('model:ollama', 1, { priority: true }), started, 'docked');
		await flush();
		first.value!.dispose(); await flush();
		assert.deepStrictEqual(started, ['first', 'docked']);
		docked.value!.dispose(); await flush();
		bg1.value!.dispose(); await flush();
		assert.deepStrictEqual(started, ['first', 'docked', 'bg1', 'bg2']);
		bg2.value!.dispose();
	});

	test('cancelled waiter is skipped', async () => {
		const q = store.add(new SlotQueue());
		const started: string[] = [];
		const cts = store.add(new CancellationTokenSource());
		const first = track(q.acquire('agents', 1), started, 'first');
		const middle = q.acquire('agents', 1, { token: cts.token });
		let middleErr: unknown;
		middle.then(() => started.push('middle'), e => { middleErr = e; });
		const third = track(q.acquire('agents', 1), started, 'third');
		await flush();
		cts.cancel();
		await flush();
		assert.ok(isCancellationError(middleErr), 'cancelled waiter rejects with CancellationError');
		assert.strictEqual(q.waiting('agents'), 1);
		first.value!.dispose(); await flush();
		assert.deepStrictEqual(started, ['first', 'third']);
		third.value!.dispose();
	});

	test('limit read per call', async () => {
		const q = store.add(new SlotQueue());
		const started: string[] = [];
		const held = [1, 2, 3].map(i => track(q.acquire('model:ollama', 3), started, `h${i}`));
		await flush();
		// the setting was lowered to 1: the next caller asks with limit 1
		const late = track(q.acquire('model:ollama', 1), started, 'late');
		await flush();
		held[0].value!.dispose(); await flush();
		assert.strictEqual(q.active('model:ollama'), 2);
		assert.deepStrictEqual(started, ['h1', 'h2', 'h3']);
		held[1].value!.dispose(); await flush();
		assert.deepStrictEqual(started, ['h1', 'h2', 'h3']);
		held[2].value!.dispose(); await flush();
		assert.deepStrictEqual(started, ['h1', 'h2', 'h3', 'late']);
		late.value!.dispose();
		// releasing twice is harmless
		late.value!.dispose();
		assert.strictEqual(q.active('model:ollama'), 0);
	});
});
