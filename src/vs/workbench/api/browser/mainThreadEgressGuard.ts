/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../base/common/errors.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IEgressGuardService } from '../../contrib/zeroEgress/common/egressGuardService.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { EgressTargetDto, ExtHostEgressGuardContext, ExtHostEgressGuardShape, MainContext, MainThreadEgressGuardShape } from '../common/extHost.protocol.js';

// ZeroEgress: relays the main-process egress allow-list to the extension host, and its blocks and allowed counts back.
@extHostNamedCustomer(MainContext.MainThreadEgressGuard)
export class MainThreadEgressGuard extends Disposable implements MainThreadEgressGuardShape {

	private readonly proxy: ExtHostEgressGuardShape;
	private subscribed = false;

	constructor(
		extHostContext: IExtHostContext,
		@IEgressGuardService private readonly egressGuardService: IEgressGuardService,
	) {
		super();
		this.proxy = extHostContext.getProxy(ExtHostEgressGuardContext);
	}

	// Only push once the extension host has asked: by then its ExtHostEgressGuard actor is registered.
	$getTargets(): Promise<EgressTargetDto[]> {
		if (!this.subscribed) {
			this.subscribed = true;
			this._register(this.egressGuardService.onDidChangeTargets(targets => this.proxy.$setTargets(targets).catch(onUnexpectedError)));
		}
		return this.egressGuardService.getTargets();
	}

	$reportBlocked(url: string): void {
		this.egressGuardService.reportBlocked(url).catch(onUnexpectedError);
	}

	$reportAllowed(counts: { url: string; count: number }[]): void { // ZeroEgress
		this.egressGuardService.reportAllowed(counts).catch(onUnexpectedError); // ZeroEgress
	} // ZeroEgress
}
