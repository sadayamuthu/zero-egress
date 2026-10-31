/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Which docked chat owns each file's unreviewed changes (state in common/changeOwners.ts, keyed by fsPath).
// A docked edit, create or delete claims its file first; once the file has nothing pending (the user accepted or
// rejected it, in the chat or in the editor), the owner is released, so the next chat to touch it gets no conflict.
// Owners live in memory only: changes that survive a reload have no owner.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ChangeOwners, ClaimResult } from '../common/changeOwners.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { IPendingFileOpsService } from './pendingFileOpsService.js';

export interface IChangeOwnersService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	ownerOf(uri: URI): string | undefined;
	claim(uri: URI, threadId: string): ClaimResult;
	transfer(uri: URI, threadId: string): void;
	releaseThread(threadId: string): void;
	ownedUris(threadId: string): URI[];
	/** True if the file has diff zones, or a pending create or delete is at its path. */
	hasPending(uri: URI): boolean;
}

export const IChangeOwnersService = createDecorator<IChangeOwnersService>('zeroEgressChangeOwnersService');

export class OwnershipConflictError extends Error {
	constructor(readonly uri: URI, readonly owner: string) {
		super(`${uri.fsPath} has unreviewed changes from another chat.`);
		this.name = 'OwnershipConflictError';
	}
}

export class ChangeOwnersService extends Disposable implements IChangeOwnersService {
	readonly _serviceBrand: undefined;

	private readonly _owners = new ChangeOwners();
	/** every owned path's URI (keys are fsPath, as in _owners), so remote files keep their scheme */
	private readonly _uris = new Map<string, URI>();
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@IPendingFileOpsService private readonly _pendingFileOpsService: IPendingFileOpsService,
	) {
		super();
		// accepting or rejecting a file's last diff (inline, in the chat or with the command bar) deletes its zone,
		// which fires this event. The edit service updates its diff areas before firing, so hasPending sees the new state
		this._register(this._editCodeService.onDidAddOrDeleteDiffZones(() => this._releaseSettled()));
		this._register(this._pendingFileOpsService.onDidChange(() => this._releaseSettled()));
	}

	ownerOf(uri: URI): string | undefined {
		return this._owners.ownerOf(uri.fsPath);
	}

	claim(uri: URI, threadId: string): ClaimResult {
		const isNew = this._owners.ownerOf(uri.fsPath) === undefined;
		const result = this._owners.claim(uri.fsPath, threadId);
		if (isNew) {
			this._uris.set(uri.fsPath, uri);
			this._onDidChange.fire();
		}
		return result;
	}

	transfer(uri: URI, threadId: string): void {
		if (this._owners.ownerOf(uri.fsPath) === threadId) {
			return;
		}
		this._owners.transfer(uri.fsPath, threadId);
		this._uris.set(uri.fsPath, uri);
		this._onDidChange.fire();
	}

	releaseThread(threadId: string): void {
		const released = this._owners.releaseThread(threadId);
		for (const p of released) {
			this._uris.delete(p);
		}
		if (released.length) {
			this._onDidChange.fire();
		}
	}

	ownedUris(threadId: string): URI[] {
		return this._owners.pathsOf(threadId).map(p => this._uris.get(p) ?? URI.file(p));
	}

	hasPending(uri: URI): boolean {
		// the edit service's diff areas, not the command bar's stateOfURI: the command bar updates from the same event
		// (so it can lag behind it), and only tracks files open in a text model; its module also loads the DOM
		for (const id of this._editCodeService.diffAreasOfURI[uri.fsPath] ?? []) {
			if (this._editCodeService.diffAreaOfId[id]?.type === 'DiffZone') {
				return true;
			}
		}
		return this._pendingFileOpsService.ops.some(op => isEqual(URI.parse(op.path), uri));
	}

	private _releaseSettled(): void {
		let changed = false;
		for (const [path, uri] of [...this._uris]) {
			if (!this.hasPending(uri)) {
				this._owners.release(path);
				this._uris.delete(path);
				changed = true;
			}
		}
		if (changed) {
			this._onDidChange.fire();
		}
	}
}

registerSingleton(IChangeOwnersService, ChangeOwnersService, InstantiationType.Delayed);
