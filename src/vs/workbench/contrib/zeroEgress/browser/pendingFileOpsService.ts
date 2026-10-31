/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Agent file creates and deletes that wait for review (state in common/pendingFileOps.ts, keyed by URI string so
// remote and Windows paths work). Creates happen on disk right away; rejecting one removes the file. Deletes only
// happen when accepted, and go to the trash where the file system has one, so a mistaken accept can be recovered.
// The agent may only create paths that do not exist yet, so a reject can never remove something the user owned.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { DiskAction, PendingFileOp, PendingFileOps } from '../common/pendingFileOps.js';
import { IEditCodeService } from './editCodeServiceInterface.js';

export interface IPendingFileOpsService {
	readonly _serviceBrand: undefined;
	/** Each op's `path` is a URI string (`URI.parse` it). */
	readonly ops: readonly PendingFileOp[];
	readonly onDidChange: Event<void>;
	/** Creates the file or folder on disk, then records it for review. Refuses a path that already exists. */
	create(uri: URI, isFolder: boolean): Promise<void>;
	/** Records a delete for review; the file stays on disk until accepted. Refuses a missing path. */
	markDeleted(uri: URI, recursive: boolean): Promise<void>;
	resolve(id: number, behavior: 'accept' | 'reject'): Promise<void>;
	/** Resolves every pending op, or only those at or under `uri`. */
	resolveAll(behavior: 'accept' | 'reject', uri?: URI): Promise<void>;
}

export const IPendingFileOpsService = createDecorator<IPendingFileOpsService>('zeroEgressPendingFileOpsService');

const isAtOrUnder = (uri: URI, base: string) => { const s = uri.toString(); return s === base || s.startsWith(base + '/'); };

export class PendingFileOpsService extends Disposable implements IPendingFileOpsService {
	readonly _serviceBrand: undefined;

	private readonly _state = new PendingFileOps();
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
	}

	get ops(): readonly PendingFileOp[] {
		return this._state.ops;
	}

	async create(uri: URI, isFolder: boolean): Promise<void> {
		const key = uri.toString();
		if (this._state.opFor(key)?.kind === 'delete') {
			// the file is still on disk (its delete was only pending): keep it, and drop the delete
			this._state.recordCreate(key, isFolder);
			this._onDidChange.fire();
			return;
		}
		if (await this._fileService.exists(uri)) {
			throw new Error(`${uri.fsPath} already exists. Edit it instead of creating it.`);
		}
		if (isFolder) {
			await this._fileService.createFolder(uri);
		} else {
			await this._fileService.createFile(uri);
		}
		await this._apply(() => this._state.recordCreate(key, isFolder));
	}

	async markDeleted(uri: URI, recursive: boolean): Promise<void> {
		const key = uri.toString();
		if (this._state.opFor(key)?.kind === 'create') {
			await this._apply(() => this._state.recordDelete(key, recursive));
			return;
		}
		const stat = await this._fileService.stat(uri).catch(() => undefined);
		if (!stat) {
			throw new Error(`${uri.fsPath} does not exist.`);
		}
		if (stat.isDirectory && !recursive && (await this._fileService.resolve(uri)).children?.length) {
			throw new Error(`${uri.fsPath} is a folder that is not empty. Set is_recursive to delete it with its contents.`);
		}
		await this._apply(() => this._state.recordDelete(key, recursive, stat.isDirectory));
	}

	resolve(id: number, behavior: 'accept' | 'reject'): Promise<void> {
		return this._apply(() => this._state.resolve(id, behavior));
	}

	resolveAll(behavior: 'accept' | 'reject', uri?: URI): Promise<void> {
		return this._apply(() => this._state.resolveAll(behavior, uri?.toString()));
	}

	/** Changes the state, then does the disk work it returns. If that fails, the state goes back and the user is told. */
	private async _apply(change: () => DiskAction[]): Promise<void> {
		const before = this._state.snapshot();
		const actions = change();
		try {
			for (const action of actions) {
				const target = URI.parse(action.path);
				// clear any pending edit diffs in the file(s) first, so no diff zone outlives its file
				for (const model of this._modelService.getModels()) {
					if (isAtOrUnder(model.uri, action.path)) {
						this._editCodeService.acceptOrRejectAllDiffAreas({ uri: model.uri, behavior: 'accept', removeCtrlKs: true, _addToHistory: false });
					}
				}
				if (await this._fileService.exists(target)) {
					const useTrash = this._fileService.hasCapability(target, FileSystemProviderCapabilities.Trash);
					await this._fileService.del(target, { recursive: action.recursive, useTrash });
				}
			}
		} catch (e) {
			this._state.restore(before);
			this._notificationService.error(`ZeroEgress could not finish the review: ${e instanceof Error ? e.message : String(e)}`);
			throw e;
		} finally {
			this._onDidChange.fire();
		}
	}
}

registerSingleton(IPendingFileOpsService, PendingFileOpsService, InstantiationType.Delayed);
