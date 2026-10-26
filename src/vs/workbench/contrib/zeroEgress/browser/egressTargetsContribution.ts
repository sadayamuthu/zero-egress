/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Feeds the configured model endpoints to the main-process egress guard, and writes every blocked
// connection to the "ZeroEgress: Network" output channel (host and caller; never the path or query).

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as OutputExtensions, IOutputChannelRegistry, IOutputService } from '../../../services/output/common/output.js';
import { BlockedAttempt, IEgressGuardService } from '../common/egressGuardService.js';
import { describeDestination } from '../common/egressPolicy.js';
import { IZeroEgressSettingsService } from '../common/zeroEgressSettingsService.js';

export const NETWORK_OUTPUT_CHANNEL_ID = 'zeroEgress.network';

Registry.as<IOutputChannelRegistry>(OutputExtensions.OutputChannels).registerChannel({ id: NETWORK_OUTPUT_CHANNEL_ID, label: 'ZeroEgress: Network', log: false });

export function formatBlockedAttempt(e: BlockedAttempt): string {
	return `${new Date(e.time).toISOString()} blocked ${describeDestination(e.url)} (caller: ${e.origin})\n`;
}

class EgressTargetsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zeroEgress.egressTargets';

	private lastSent: string | undefined;

	constructor(
		@IEgressGuardService private readonly egressGuardService: IEgressGuardService,
		@IZeroEgressSettingsService private readonly settingsService: IZeroEgressSettingsService,
		@IOutputService private readonly outputService: IOutputService,
	) {
		super();

		// Subscribe before reading the backlog; a block landing in between may show twice, never zero times.
		this._register(this.egressGuardService.onDidBlock(e => this.log(e)));
		this.egressGuardService.getRecentBlocked().then(recent => recent.forEach(e => this.log(e)));

		// The settings service fires onDidChangeState synchronously when its stored state is first read,
		// ahead of anything awaiting waitForInitState (e.g. model refresh), so endpoints reach main first.
		this.sendEndpoints();
		this._register(this.settingsService.onDidChangeState(() => this.sendEndpoints()));
	}

	private sendEndpoints(): void {
		const endpoints = Object.values(this.settingsService.state.settingsOfProvider)
			.map(p => p.endpoint)
			.filter((e): e is string => !!e);
		const key = JSON.stringify(endpoints);
		if (key === this.lastSent) {
			return;
		}
		this.lastSent = key;
		void this.egressGuardService.setTargets('settings', endpoints);
	}

	private log(e: BlockedAttempt): void {
		this.outputService.getChannel(NETWORK_OUTPUT_CHANNEL_ID)?.append(formatBlockedAttempt(e));
	}
}

registerWorkbenchContribution2(EgressTargetsContribution.ID, EgressTargetsContribution, WorkbenchPhase.BlockStartup);
