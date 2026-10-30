/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { EgressProofPeriod, IEgressProofService } from '../../common/egressProofService.js';

/**
 * The Egress Proof IPC channel. Only the IEgressProofService methods are callable, with their arguments type-checked:
 * nothing else on the main service (the signing key, the ledger) is reachable from a renderer.
 */
export class EgressProofChannel implements IServerChannel<string> {

	constructor(private readonly service: Omit<IEgressProofService, '_serviceBrand'>) { }

	listen(_ctx: string, event: string): Event<any> {
		throw new Error(`Event not found: ${event}`);
	}

	async call(_ctx: string, command: string, arg?: any): Promise<any> {
		const args: unknown[] = Array.isArray(arg) ? arg : [];
		const optionalString = (v: unknown) => typeof v === 'string' ? v : undefined;
		switch (command) {
			case 'getSummary': return this.service.getSummary();
			case 'createReport': return this.service.createReport(periodArg(args[0]), args[1] === true);
			case 'verifyReport': {
				if (typeof args[0] !== 'string') { throw new Error('ZeroEgress: verifyReport needs a report path'); }
				return this.service.verifyReport(args[0], optionalString(args[1]));
			}
			case 'pickReportFiles': return this.service.pickReportFiles();
		}
		throw new Error(`Call not found: ${command}`);
	}
}

function periodArg(v: unknown): EgressProofPeriod {
	const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
	if (typeof o.days === 'number') { return { days: o.days }; }
	if (typeof o.from === 'string' && typeof o.to === 'string') { return { from: o.from, to: o.to }; }
	throw new Error('ZeroEgress: invalid report period');
}
