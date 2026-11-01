/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Status bar entry: "<Provider> · <active> of <limit> slots" for the provider of the Chat feature's selected model.
// Hidden when no model is selected.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IZeroEgressSettingsService } from '../common/zeroEgressSettingsService.js';
import { displayInfoOfProviderName, parallelRequestsOf } from '../common/zeroEgressSettingsTypes.js';
import { IChatThreadService } from './chatThreadService.js';

class ModelSlotsStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zeroEgress.modelSlotsStatus';

	private _entry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@IZeroEgressSettingsService private readonly _settingsService: IZeroEgressSettingsService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
	) {
		super();
		this._register(this._chatThreadService.slotQueue.onDidChange(() => this._render()));
		this._register(this._settingsService.onDidChangeState(() => this._render()));
		this._render();
	}

	private _render(): void {
		const selection = this._settingsService.state.modelSelectionOfFeature['Chat'];
		if (!selection) {
			this._entry?.dispose();
			this._entry = undefined;
			return;
		}
		const { providerName } = selection;
		const limit = parallelRequestsOf(this._settingsService.state.settingsOfProvider[providerName]);
		const active = this._chatThreadService.slotQueue.active(`model:${providerName}`);
		const text = `${displayInfoOfProviderName(providerName).title} · ${active} of ${limit} slots`;
		const props = {
			name: 'ZeroEgress Model Slots',
			text,
			ariaLabel: text,
			tooltip: 'Requests running on this provider, out of the parallel requests it allows',
		};
		if (this._entry) {
			this._entry.update(props);
		} else {
			// same alignment as zeroEgress.localStatus (LEFT), one step ahead of it so the two sit together
			this._entry = this._statusbarService.addEntry(props, 'zeroEgress.modelSlots', StatusbarAlignment.LEFT, 10001);
		}
	}

	override dispose(): void {
		this._entry?.dispose();
		this._entry = undefined;
		super.dispose();
	}
}

registerWorkbenchContribution2(ModelSlotsStatusContribution.ID, ModelSlotsStatusContribution, WorkbenchPhase.AfterRestored);
