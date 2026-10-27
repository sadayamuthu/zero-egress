/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZeroEgress contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IStateService } from '../../../state/node/state.js';
import { resolveMachineId, resolveSqmId, resolvedevDeviceId } from '../../electron-main/telemetryUtils.js';
import { zeroEgressDevDeviceIdKey, zeroEgressMachineIdKey } from '../../node/telemetryUtils.js';
import { devDeviceIdKey, machineIdKey, sqmIdKey } from '../../common/telemetry.js';

class MemoryStateService implements IStateService {
	declare readonly _serviceBrand: undefined;
	readonly items = new Map<string, unknown>();
	getItem<T>(key: string, defaultValue?: T): T | undefined { return (this.items.has(key) ? this.items.get(key) : defaultValue) as T | undefined; }
	setItem(key: string, data?: unknown): void { this.items.set(key, data); }
	setItems(items: readonly { key: string; data?: unknown }[]): void { items.forEach(i => this.setItem(i.key, i.data)); }
	removeItem(key: string): void { this.items.delete(key); }
	async close(): Promise<void> { }
}

suite('ZeroEgress install identifiers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	const log = new NullLogService();

	test('ignores and deletes identifiers an earlier build stored under the upstream keys', async () => {
		const state = new MemoryStateService();
		const macHash = 'a'.repeat(64);
		state.setItem(machineIdKey, macHash);
		state.setItem(sqmIdKey, '{SQM-MACHINE-ID}');
		state.setItem(devDeviceIdKey, '11111111-1111-4111-8111-111111111111');

		const [machineId, sqmId, devDeviceId] = await Promise.all([
			resolveMachineId(state, log), resolveSqmId(state, log), resolvedevDeviceId(state, log)
		]);

		assert.match(machineId, UUID);
		assert.notStrictEqual(machineId, macHash);
		assert.strictEqual(sqmId, '');
		assert.match(devDeviceId, UUID);
		assert.notStrictEqual(devDeviceId, '11111111-1111-4111-8111-111111111111');
		for (const key of [machineIdKey, sqmIdKey, devDeviceIdKey]) {
			assert.strictEqual(state.getItem(key), undefined, `${key} was not removed`);
		}
		assert.strictEqual(state.getItem(zeroEgressMachineIdKey), machineId);
		assert.strictEqual(state.getItem(zeroEgressDevDeviceIdKey), devDeviceId);
	});

	test('the stored identifiers are stable across launches', async () => {
		const state = new MemoryStateService();
		state.setItem(zeroEgressMachineIdKey, '22222222-2222-4222-8222-222222222222');
		state.setItem(zeroEgressDevDeviceIdKey, '33333333-3333-4333-8333-333333333333');
		assert.strictEqual(await resolveMachineId(state, log), '22222222-2222-4222-8222-222222222222');
		assert.strictEqual(await resolvedevDeviceId(state, log), '33333333-3333-4333-8333-333333333333');
	});
});
