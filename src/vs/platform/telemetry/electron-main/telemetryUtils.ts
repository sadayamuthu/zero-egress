/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../log/common/log.js';
import { IStateService } from '../../state/node/state.js';
import { legacyIdKeys, resolveMachineId as resolveNodeMachineId, resolveSqmId as resolveNodeSqmId, resolvedevDeviceId as resolveNodedevDeviceId, zeroEgressDevDeviceIdKey, zeroEgressMachineIdKey } from '../node/telemetryUtils.js';

export async function resolveMachineId(stateService: IStateService, logService: ILogService): Promise<string> {
	// Call the node layers implementation to avoid code duplication
	const machineId = await resolveNodeMachineId(stateService, logService);
	stateService.setItem(zeroEgressMachineIdKey, machineId);
	removeLegacyIds(stateService);
	return machineId;
}

export async function resolveSqmId(stateService: IStateService, logService: ILogService): Promise<string> {
	return resolveNodeSqmId(stateService, logService);
}

export async function resolvedevDeviceId(stateService: IStateService, logService: ILogService): Promise<string> {
	const devDeviceId = await resolveNodedevDeviceId(stateService, logService);
	stateService.setItem(zeroEgressDevDeviceIdKey, devDeviceId);
	return devDeviceId;
}

/** Drops the identifiers an earlier build stored under upstream's keys. */
function removeLegacyIds(stateService: IStateService): void {
	for (const key of legacyIdKeys) {
		if (stateService.getItem(key) !== undefined) {
			stateService.removeItem(key);
		}
	}
}
