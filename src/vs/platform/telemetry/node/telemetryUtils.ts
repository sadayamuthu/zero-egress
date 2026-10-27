/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getMachineId, getSqmMachineId, getdevDeviceId } from '../../../base/node/id.js';
import { ILogService } from '../../log/common/log.js';
import { IStateReadService } from '../../state/node/state.js';
import { machineIdKey, sqmIdKey, devDeviceIdKey } from '../common/telemetry.js';

// ZeroEgress: the machine and device IDs are random UUIDs created once per
// installation and kept in this app's state (storage.json in the user data
// folder). They live under their own keys: the upstream keys
// (telemetry.machineId, telemetry.devDeviceId, telemetry.sqmId) may hold a
// MAC-address hash, the Windows SQM ID or the device ID shared with
// Microsoft's tools from an earlier build, and are never read; the main
// process deletes them (see ../electron-main/telemetryUtils.ts).
export const zeroEgressMachineIdKey = 'zeroEgress.machineId';
export const zeroEgressDevDeviceIdKey = 'zeroEgress.devDeviceId';
export const legacyIdKeys: readonly string[] = [machineIdKey, sqmIdKey, devDeviceIdKey];

export async function resolveMachineId(stateService: IStateReadService, logService: ILogService): Promise<string> {
	const machineId = stateService.getItem<string>(zeroEgressMachineIdKey);
	return typeof machineId === 'string' && machineId ? machineId : getMachineId(logService.error.bind(logService));
}

export async function resolveSqmId(_stateService: IStateReadService, logService: ILogService): Promise<string> {
	return getSqmMachineId(logService.error.bind(logService));
}

export async function resolvedevDeviceId(stateService: IStateReadService, logService: ILogService): Promise<string> {
	const devDeviceId = stateService.getItem<string>(zeroEgressDevDeviceIdKey);
	return typeof devDeviceId === 'string' && devDeviceId ? devDeviceId : getdevDeviceId(logService.error.bind(logService));
}
