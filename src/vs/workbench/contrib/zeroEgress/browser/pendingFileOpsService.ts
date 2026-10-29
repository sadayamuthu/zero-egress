/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Agent file creates and deletes that wait for review (state in common/pendingFileOps.ts). Creates happen on
// disk right away; rejecting one removes the file. Deletes only happen when accepted, and go to the trash so a
// mistaken accept can be recovered.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { DiskAction, PendingFileOp, PendingFileOps } from '../common/pendingFileOps.js';
import { IEditCodeService } from './editCodeServiceInterface.js';

export interface IPendingFileOpsService {
	readonly _serviceBrand: undefined;
	readonly ops: readonly PendingFileOp[];
	readonly onDidChange: Event<void>;
	/** Creates the file or folder on disk, then records it for review. */
	create(uri: URI, isFolder: boolean): Promise<void>;
	/** Records a delete for review; the file stays on disk until accepted. */
	markDeleted(uri: URI, recursive: boolean): Promise<void>;
	resolve(id: number, behavior: 'accept' | 'reject'): Promise<void>;
	/** Resolves every pending op, or only those at or under `uri`. */
	resolveAll(behavior: 'accept' | 'reject', uri?: URI): Promise<void>;
}

export const IPendingFileOpsService = createDecorator<IPendingFileOpsService>('zeroEgressPendingFileOpsService');

class PendingFileOpsService extends Disposable implements IPendingFileOpsService {
	readonly _serviceBrand: undefined;

	private readonly _state = new PendingFileOps();
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
	) {
		super();
	}

	get ops(): readonly PendingFileOp[] {
		return this._state.ops;
	}

	async create(uri: URI, isFolder: boolean): Promise<void> {
		if (isFolder) {
			await this._fileService.createFolder(uri);
		} else {
			await this._fileService.createFile(uri);
		}
		await this._apply(this._state.recordCreate(uri.fsPath, isFolder));
	}

	async markDeleted(uri: URI, recursive: boolean): Promise<void> {
		await this._apply(this._state.recordDelete(uri.fsPath, recursive));
	}

	async resolve(id: number, behavior: 'accept' | 'reject'): Promise<void> {
		await this._apply(this._state.resolve(id, behavior));
	}

	async resolveAll(behavior: 'accept' | 'reject', uri?: URI): Promise<void> {
		await this._apply(this._state.resolveAll(behavior, uri?.fsPath));
	}

	private async _apply(actions: DiskAction[]): Promise<void> {
		try {
			for (const action of actions) {
				const target = URI.file(action.path);
				// clear any pending edit diffs in the file(s) first, so no diff zone outlives its file
				for (const model of this._modelService.getModels()) {
					if (model.uri.scheme === 'file' && (model.uri.fsPath === action.path || model.uri.fsPath.startsWith(action.path + '/'))) {
						this._editCodeService.acceptOrRejectAllDiffAreas({ uri: model.uri, behavior: 'accept', removeCtrlKs: true, _addToHistory: false });
					}
				}
				if (await this._fileService.exists(target)) {
					await this._fileService.del(target, { recursive: action.recursive, useTrash: true });
				}
			}
		} finally {
			this._onDidChange.fire();
		}
	}
}

registerSingleton(IPendingFileOpsService, PendingFileOpsService, InstantiationType.Delayed);
