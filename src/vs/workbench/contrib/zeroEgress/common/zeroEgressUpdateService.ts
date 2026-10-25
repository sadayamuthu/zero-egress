/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ZeroEgressCheckUpdateRespose } from './zeroEgressUpdateServiceTypes.js';



export interface IZeroEgressUpdateService {
	readonly _serviceBrand: undefined;
	check: (explicit: boolean) => Promise<ZeroEgressCheckUpdateRespose>;
}


export const IZeroEgressUpdateService = createDecorator<IZeroEgressUpdateService>('ZeroEgressUpdateService');


// implemented by calling channel
export class ZeroEgressUpdateService implements IZeroEgressUpdateService {

	readonly _serviceBrand: undefined;
	private readonly zeroEgressUpdateService: IZeroEgressUpdateService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService, // (only usable on client side)
	) {
		// creates an IPC proxy to use metricsMainService.ts
		this.zeroEgressUpdateService = ProxyChannel.toService<IZeroEgressUpdateService>(mainProcessService.getChannel('zero-egress-channel-update'));
	}


	// anything transmitted over a channel must be async even if it looks like it doesn't have to be
	check: IZeroEgressUpdateService['check'] = async (explicit) => {
		const res = await this.zeroEgressUpdateService.check(explicit)
		return res
	}
}

registerSingleton(IZeroEgressUpdateService, ZeroEgressUpdateService, InstantiationType.Eager);


