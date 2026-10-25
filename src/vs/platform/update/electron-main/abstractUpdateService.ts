/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService, LifecycleMainPhase } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IRequestService } from '../../request/common/request.js';
import { AvailableForDownload, DisablementReason, IUpdateService, State, StateType, UpdateType } from '../common/update.js';

export function createUpdateURL(platform: string, quality: string, productService: IProductService): string {
	return `${productService.updateUrl}/api/update/${platform}/${quality}/${productService.commit}`;
}

export type UpdateErrorClassification = {
	owner: 'joaomoreno';
	messageHash: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The hash of the error message.' };
	comment: 'This is used to know how often VS Code updates have failed.';
};

export abstract class AbstractUpdateService implements IUpdateService {

	declare readonly _serviceBrand: undefined;

	protected url: string | undefined;

	private _state: State = State.Uninitialized;

	private readonly _onStateChange = new Emitter<State>();
	readonly onStateChange: Event<State> = this._onStateChange.event;

	get state(): State {
		return this._state;
	}

	protected setState(state: State): void {
		this.logService.info('update#setState', state.type);
		this._state = state;
		this._onStateChange.fire(state);
	}

	constructor(
		@ILifecycleMainService protected readonly lifecycleMainService: ILifecycleMainService,
		@IConfigurationService protected configurationService: IConfigurationService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IRequestService protected requestService: IRequestService,
		@ILogService protected logService: ILogService,
		@IProductService protected readonly productService: IProductService
	) {
		lifecycleMainService.when(LifecycleMainPhase.AfterWindowOpen)
			.finally(() => this.initialize());
	}

	/**
	 * This must be called before any other call. This is a performance
	 * optimization, to avoid using extra CPU cycles before first window open.
	 * https://github.com/microsoft/vscode/issues/89784
	 */
	protected async initialize(): Promise<void> {
		// ZeroEgress: application updates are permanently disabled. The update
		// service never constructs an external update feed URL, never sets its
		// state to Idle, and never schedules an update check. State is forced to
		// Disabled unconditionally regardless of environment or configuration.
		const reason = this.environmentMainService.isBuilt
			? DisablementReason.DisabledByEnvironment
			: DisablementReason.NotBuilt;
		this.setState(State.Disabled(reason));
		this.logService.info('update#ctor - updates are permanently disabled (ZeroEgress)');
	}

	async checkForUpdates(explicit: boolean): Promise<void> {
		this.logService.trace('update#checkForUpdates, state = ', this.state.type);

		if (this.state.type !== StateType.Idle) {
			return;
		}

		this.doCheckForUpdates(explicit);
	}

	async downloadUpdate(): Promise<void> {
		this.logService.trace('update#downloadUpdate, state = ', this.state.type);

		if (this.state.type !== StateType.AvailableForDownload) {
			return;
		}

		await this.doDownloadUpdate(this.state);
	}

	protected async doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		// noop
	}

	async applyUpdate(): Promise<void> {
		this.logService.trace('update#applyUpdate, state = ', this.state.type);

		if (this.state.type !== StateType.Downloaded) {
			return;
		}

		await this.doApplyUpdate();
	}

	protected async doApplyUpdate(): Promise<void> {
		// noop
	}

	quitAndInstall(): Promise<void> {
		this.logService.trace('update#quitAndInstall, state = ', this.state.type);

		if (this.state.type !== StateType.Ready) {
			return Promise.resolve(undefined);
		}

		this.logService.trace('update#quitAndInstall(): before lifecycle quit()');

		this.lifecycleMainService.quit(true /* will restart */).then(vetod => {
			this.logService.trace(`update#quitAndInstall(): after lifecycle quit() with veto: ${vetod}`);
			if (vetod) {
				return;
			}

			this.logService.trace('update#quitAndInstall(): running raw#quitAndInstall()');
			this.doQuitAndInstall();
		});

		return Promise.resolve(undefined);
	}

	async isLatestVersion(): Promise<boolean | undefined> {
		if (!this.url) {
			return undefined;
		}

		const mode = this.configurationService.getValue<'none' | 'manual' | 'start' | 'default'>('update.mode');

		if (mode === 'none') {
			return false;
		}

		try {
			const context = await this.requestService.request({ url: this.url }, CancellationToken.None);
			// The update server replies with 204 (No Content) when no
			// update is available - that's all we want to know.
			return context.res.statusCode === 204;

		} catch (error) {
			this.logService.error('update#isLatestVersion(): failed to check for updates');
			this.logService.error(error);
			return undefined;
		}
	}

	async _applySpecificUpdate(packagePath: string): Promise<void> {
		// noop
	}

	protected getUpdateType(): UpdateType {
		return UpdateType.Archive;
	}

	protected doQuitAndInstall(): void {
		// noop
	}

	protected abstract buildUpdateFeedUrl(quality: string): string | undefined;
	protected abstract doCheckForUpdates(context: any): void;
}
