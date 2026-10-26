/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ILogService } from '../../../platform/log/common/log.js';
import { isAllowed } from '../../contrib/zeroEgress/common/egressPolicy.js';
import { EgressTargetDto, ExtHostEgressGuardShape, MainThreadEgressGuardShape } from '../common/extHost.protocol.js';

/**
 * ZeroEgress: the extension host's copy of the egress allow-list, enforced by the Node hooks that
 * proxyResolver installs. The renderer's MainThreadEgressGuard relays the list from the main-process
 * guard; blocks are reported back there for the "ZeroEgress: Network" log. Until the first list
 * arrives (or if it never does), only loopback is reachable.
 */
export class ExtHostEgressGuard implements ExtHostEgressGuardShape {
	private targets: EgressTargetDto[] = [];
	private pushed = false;

	constructor(private readonly mainThread: MainThreadEgressGuardShape, private readonly log: ILogService) { }

	async init(): Promise<void> {
		try {
			const targets = await this.mainThread.$getTargets();
			if (!this.pushed) { this.targets = targets; } // a push that raced the reply is newer
		} catch (e) {
			this.log.error('ZeroEgress: could not load egress targets; only loopback is reachable', e);
		}
	}

	async $setTargets(targets: EgressTargetDto[]): Promise<void> {
		this.pushed = true;
		this.targets = targets;
	}

	readonly check = (url: string): boolean => {
		if (isAllowed(url, this.targets)) {
			return true;
		}
		this.mainThread.$reportBlocked(url);
		return false;
	};
}
