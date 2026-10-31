/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js'; // ZeroEgress
import { ILogService } from '../../../platform/log/common/log.js';
import { isAllowed } from '../../contrib/zeroEgress/common/egressPolicy.js';
import { AllowedCountBatcher, EgressCheckKind } from '../../contrib/zeroEgress/node/egressNodeHooks.js'; // ZeroEgress
import { EgressTargetDto, ExtHostEgressGuardShape, MainThreadEgressGuardShape } from '../common/extHost.protocol.js';

/**
 * ZeroEgress: the extension host's copy of the egress allow-list, enforced by the Node hooks that
 * proxyResolver installs. The renderer's MainThreadEgressGuard relays the list from the main-process
 * guard; blocks are reported back there for the "ZeroEgress: Network" log. Until the first list
 * arrives (or if it never does), only loopback is reachable. Allowed socket and Electron net checks are counted per URL
 * and reported every 10 s for the egress ledger. (ZeroEgress)
 */
export class ExtHostEgressGuard extends Disposable implements ExtHostEgressGuardShape { // ZeroEgress
	private targets: EgressTargetDto[] = [];
	private pushed = false;
	private readonly allowed: AllowedCountBatcher; // ZeroEgress

	constructor(private readonly mainThread: MainThreadEgressGuardShape, private readonly log: ILogService) { // ZeroEgress
		super(); // ZeroEgress
		this.allowed = this._register(new AllowedCountBatcher(counts => this.mainThread.$reportAllowed(counts))); // ZeroEgress
	} // ZeroEgress

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

	readonly check = (url: string, kind?: EgressCheckKind): boolean => { // ZeroEgress
		if (isAllowed(url, this.targets)) {
			if (kind === 'socket' || kind === 'electronNet') { this.allowed.add(url); } // ZeroEgress: one per connection
			return true;
		}
		this.mainThread.$reportBlocked(url);
		return false;
	};

	/** Sends the allowed counts gathered so far (the interval does this; exposed for tests). */ // ZeroEgress
	flushAllowed(): void { // ZeroEgress
		this.allowed.flush(); // ZeroEgress
	} // ZeroEgress
}
