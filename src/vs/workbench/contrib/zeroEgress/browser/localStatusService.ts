/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Where the app may connect (Local / LAN / Internet) and how many connections the egress guard blocked this
// session. One source for the status bar, the title bar pill and the Settings page, so they always agree.
// It asks the guard for its targets and blocked log; it makes no network call of its own.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IEgressGuardService } from '../common/egressGuardService.js';
import { formatLocalStatus, LocalStatus, localStatusOf } from '../common/localStatus.js';
import { IZeroEgressSettingsService } from '../common/zeroEgressSettingsService.js';

export interface ILocalStatusService {
	readonly _serviceBrand: undefined;
	/** `undefined` until the guard's targets are read, or when they could not be read */
	readonly status: LocalStatus | undefined;
	/** connections the guard blocked this session */
	readonly blocked: number;
	readonly onDidChange: Event<void>;
	/** the status bar text (with codicon syntax) and tooltip */
	formatted(): { text: string; tooltip: string };
}

export const ILocalStatusService = createDecorator<ILocalStatusService>('zeroEgressLocalStatusService');

export class LocalStatusService extends Disposable implements ILocalStatusService {
	declare readonly _serviceBrand: undefined;

	private _status: LocalStatus | undefined;
	private _blocked = 0;
	private refreshSeq = 0;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	get status() { return this._status; }
	get blocked() { return this._blocked; }

	constructor(
		@IEgressGuardService private readonly egressGuardService: IEgressGuardService,
		@IZeroEgressSettingsService settingsService: IZeroEgressSettingsService,
	) {
		super();
		this._register(this.egressGuardService.onDidBlock(() => { this._blocked++; this._onDidChange.fire(); }));
		this.egressGuardService.getRecentBlocked().then(recent => { this._blocked += recent.length; this._onDidChange.fire(); }, () => { });

		this._register(settingsService.onDidChangeState(() => this.refresh()));
		this._register(this.egressGuardService.onDidChangeTargets(() => this.refresh()));
		this.refresh();
	}

	formatted() {
		return formatLocalStatus(this._status, this._blocked);
	}

	private async refresh(): Promise<void> {
		const seq = ++this.refreshSeq;
		let status: LocalStatus | undefined;
		try {
			status = localStatusOf(await this.egressGuardService.getTargets());
		} catch {
			status = undefined;
		}
		if (seq === this.refreshSeq) { // a later refresh started meanwhile: its answer wins
			this._status = status;
			this._onDidChange.fire();
		}
	}
}

registerSingleton(ILocalStatusService, LocalStatusService, InstantiationType.Delayed);
