/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { FileAccess } from '../../common/network.js';
import { getMachineId, getSqmMachineId, getdevDeviceId } from '../../node/id.js';
import { getMac } from '../../node/macAddress.js';
import { flakySuite } from './testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

flakySuite('ID', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

	test('getMachineId is a random UUID, not a hash of the MAC address', async function () {
		const errors: unknown[] = [];
		const id = await getMachineId(err => errors.push(err));
		assert.match(id, UUID);
		assert.notStrictEqual(id, createHash('sha256').update(getMac(), 'utf8').digest('hex'));
		assert.strictEqual(await getMachineId(err => errors.push(err)), id, 'stable within a process');
		assert.strictEqual(errors.length, 0);
	});

	test('getSqmId is empty (the Windows SQM MachineId is never read)', async function () {
		const errors: unknown[] = [];
		assert.strictEqual(await getSqmMachineId(err => errors.push(err)), '');
		assert.strictEqual(errors.length, 0);
	});

	test('getdevDeviceId is a random UUID, unrelated to the machine ID', async function () {
		const errors: unknown[] = [];
		const id = await getdevDeviceId(err => errors.push(err));
		assert.match(id, UUID);
		assert.notStrictEqual(id, await getMachineId(err => errors.push(err)));
		assert.strictEqual(errors.length, 0);
	});

	test('id.ts does not use @vscode/deviceid, the MAC address or the registry', function () {
		const source = readFileSync(FileAccess.asFileUri('vs/base/node/id.js').fsPath, 'utf8');
		for (const banned of ['\'@vscode/deviceid\'', 'macAddress.js', 'windows-registry\'', 'SQMClient']) {
			assert.ok(!source.includes(banned), `id.js mentions ${banned}`);
		}
	});

	test('getMac', async () => {
		const macAddress = getMac();
		assert.ok(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(macAddress), `Expected a MAC address, got: ${macAddress}`);
	});
});
