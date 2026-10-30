/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { EgressProofVerification } from './egressProof.js';

export const EGRESS_PROOF_CHANNEL = 'zero-egress-channel-egress-proof';

export interface EgressProofSummary {
	/** When recording started on this profile: the ledger's creation, or the profile's marker if the ledger was reset since. */
	since: string;
	/** When the ledger was reset (deleted and recreated), if it was: the verdict then has gaps. */
	resetSince?: string;
	destinations: number;
	blocked: number;
	intact: boolean;
	verdict: 'ok' | 'gaps';
	scope: string;
	fingerprint: string;
}

export type EgressProofPeriod = { days: number } | { from: string; to: string };

/** Renderer view of the main-process Egress Proof service (electron-main/egressLedger/egressProofMainService.ts). */
export interface IEgressProofService {
	readonly _serviceBrand: undefined;
	getSummary(): Promise<EgressProofSummary>;
	/** Main shows the folder picker; `undefined` when it is cancelled. */
	createReport(opts: EgressProofPeriod, includeModelUsage: boolean): Promise<{ jsonPath: string; pdfPath: string } | undefined>;
	/** Checks in order, and the fingerprint main computed from the report's public key. */
	verifyReport(jsonPath: string, pdfPath?: string): Promise<EgressProofVerification>;
	pickReportFiles(): Promise<{ jsonPath: string; pdfPath?: string } | undefined>;
}

export const IEgressProofService = createDecorator<IEgressProofService>('zeroEgressProofService');

// implemented by calling the channel registered in app.ts
export class EgressProofService implements IEgressProofService {
	readonly _serviceBrand: undefined;
	private readonly proxy: IEgressProofService;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.proxy = ProxyChannel.toService<IEgressProofService>(mainProcessService.getChannel(EGRESS_PROOF_CHANNEL));
	}

	getSummary() { return this.proxy.getSummary(); }
	createReport(opts: EgressProofPeriod, includeModelUsage: boolean) { return this.proxy.createReport(opts, includeModelUsage); }
	verifyReport(jsonPath: string, pdfPath?: string) { return this.proxy.verifyReport(jsonPath, pdfPath); }
	pickReportFiles() { return this.proxy.pickReportFiles(); }
}

registerSingleton(IEgressProofService, EgressProofService, InstantiationType.Delayed);
