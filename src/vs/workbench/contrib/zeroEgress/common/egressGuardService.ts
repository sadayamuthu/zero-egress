/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { EgressTarget } from './egressPolicy.js';

/** Who supplied an allow-list entry. Each source's list is replaced wholesale on update. */
export type EgressSource = 'settings' | 'mcp' | 'audit';

export interface BlockedAttempt {
	readonly url: string;
	readonly origin: 'renderer' | 'main' | 'extensionHost';
	readonly time: number;
}

export const EGRESS_GUARD_CHANNEL = 'zero-egress-channel-egress';

/**
 * Renderer view of the main-process egress guard (electron-main/egressGuard.ts).
 * The renderer may only replace the 'settings' source; MCP and audit targets are owned by electron-main.
 */
export interface IEgressGuardService {
	readonly _serviceBrand: undefined;
	setTargets(source: 'settings', urls: string[]): Promise<void>;
	/** The merged allow-list (all sources), for pushing to the extension host. */
	getTargets(): Promise<EgressTarget[]>;
	/** Records a block that happened in the extension host. */
	reportBlocked(url: string): Promise<void>;
	/** Blocks that happened before this window subscribed (bounded). */
	getRecentBlocked(): Promise<BlockedAttempt[]>;
	readonly onDidBlock: Event<BlockedAttempt>;
	readonly onDidChangeTargets: Event<EgressTarget[]>;
}

export const IEgressGuardService = createDecorator<IEgressGuardService>('zeroEgressGuardService');

// implemented by calling the channel registered in app.ts (served by EgressGuardMainService)
export class EgressGuardService implements IEgressGuardService {
	readonly _serviceBrand: undefined;
	private readonly proxy: IEgressGuardService;
	readonly onDidBlock: Event<BlockedAttempt>;
	readonly onDidChangeTargets: Event<EgressTarget[]>;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.proxy = ProxyChannel.toService<IEgressGuardService>(mainProcessService.getChannel(EGRESS_GUARD_CHANNEL));
		this.onDidBlock = this.proxy.onDidBlock;
		this.onDidChangeTargets = this.proxy.onDidChangeTargets;
	}

	setTargets(source: 'settings', urls: string[]) { return this.proxy.setTargets(source, urls); }
	getTargets() { return this.proxy.getTargets(); }
	reportBlocked(url: string) { return this.proxy.reportBlocked(url); }
	getRecentBlocked() { return this.proxy.getRecentBlocked(); }
}

registerSingleton(IEgressGuardService, EgressGuardService, InstantiationType.Delayed);
