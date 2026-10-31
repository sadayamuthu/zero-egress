/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Which docked chat owns each file's unreviewed changes (state in common/changeOwners.ts, keyed by fsPath).
// A docked edit, create or delete claims its file first; once the file has nothing pending (the user accepted or
// rejected it, in the chat or in the editor), the owner is released, so the next chat to touch it gets no conflict.
// Owners live in memory only: changes that survive a reload have no owner.
// Docked tools go through beginWrite, which checks for conflicts and claims in the same tick and keeps the path
// "in flight" until the write is done: an in-flight path counts as pending for other chats and is never released.
// The conflict check also covers folders: a path conflicts with another chat's pending changes at or under it, and
// with another chat's pending (or in-flight) folder delete above it. Owner keys stay per file.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual, isEqualOrParent } from '../../../../base/common/resources.js';
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
	/**
	 * For a docked tool, before it writes: throws OwnershipConflictError if another chat has pending or in-flight
	 * changes at or under `uri`, or a pending or in-flight folder delete above it. Otherwise claims `uri` (taking it
	 * over from an owner with nothing pending) and keeps it in flight until the returned disposable is disposed.
	 */
	beginWrite(uri: URI, threadId: string, kind: WriteKind): IDisposable;
	/** Read-only: the chat whose changes would stop `threadId` writing `uri` (the same rule as beginWrite), if any. */
	conflictFor(uri: URI, threadId: string): { owner: string } | undefined;
	/**
	 * Read-only: what to resolve so `threadId` can write `uri`. The conflicting chat's owned paths at or under `uri`
	 * (resolve their diffs and pending ops), and the ids of its pending folder deletes above `uri`.
	 */
	changesBlocking(uri: URI, threadId: string): BlockingChanges | undefined;
}

export interface BlockingChanges { readonly owner: string; readonly uris: URI[]; readonly opIds: number[] }

export type WriteKind = 'edit' | 'create' | 'delete';

interface InFlightWrite { readonly uri: URI; readonly threadId: string; readonly kind: WriteKind }

export const IChangeOwnersService = createDecorator<IChangeOwnersService>('zeroEgressChangeOwnersService');

/** `uri` is the path holding the other chat's changes (the target itself, or a path under or above it). */
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
	private readonly _inFlight = new Set<InFlightWrite>();
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

	beginWrite(uri: URI, threadId: string, kind: WriteKind): IDisposable {
		const conflict = this._conflictFor(uri, threadId);
		if (conflict) {
			throw new OwnershipConflictError(conflict.uri, conflict.owner);
		}
		if (!this.claim(uri, threadId).ok) {
			this.transfer(uri, threadId); // the other owner has nothing pending here (else _conflictFor threw)
		}
		const write: InFlightWrite = { uri, threadId, kind };
		this._inFlight.add(write);
		return toDisposable(() => {
			this._inFlight.delete(write);
			this._releaseSettled(); // a write that failed leaves nothing pending, so no owner either
		});
	}

	conflictFor(uri: URI, threadId: string): { owner: string } | undefined {
		const conflict = this._conflictFor(uri, threadId);
		return conflict && { owner: conflict.owner };
	}

	changesBlocking(uri: URI, threadId: string): BlockingChanges | undefined {
		const conflict = this._conflictFor(uri, threadId);
		if (!conflict) {
			return undefined;
		}
		const { owner } = conflict;
		const uris = this.ownedUris(owner).filter(u => isEqualOrParent(u, uri));
		const opIds = this._pendingFileOpsService.ops
			.filter(op => {
				if (op.kind !== 'delete') {
					return false;
				}
				const folder = URI.parse(op.path);
				return this.ownerOf(folder) === owner && isEqualOrParent(uri, folder) && !isEqual(uri, folder);
			})
			.map(op => op.id);
		return { owner, uris, opIds };
	}

	private _isInFlight(path: string): boolean {
		for (const w of this._inFlight) {
			if (w.uri.fsPath === path) {
				return true;
			}
		}
		return false;
	}

	private _conflictFor(uri: URI, threadId: string): { uri: URI; owner: string } | undefined {
		// another chat's pending or in-flight changes at or under uri (the file itself, or inside a folder op's path)
		for (const [path, owned] of this._uris) {
			const owner = this._owners.ownerOf(path);
			if (owner === undefined || owner === threadId || !isEqualOrParent(owned, uri)) {
				continue;
			}
			if (this._isInFlight(path) || this.hasPending(owned)) {
				return { uri: owned, owner };
			}
		}
		// another chat's folder delete above uri, pending or in flight
		for (const op of this._pendingFileOpsService.ops) {
			if (op.kind !== 'delete') {
				continue;
			}
			const folder = URI.parse(op.path);
			const owner = this.ownerOf(folder);
			if (owner !== undefined && owner !== threadId && isEqualOrParent(uri, folder)) {
				return { uri: folder, owner };
			}
		}
		for (const w of this._inFlight) {
			if (w.kind === 'delete' && w.threadId !== threadId && isEqualOrParent(uri, w.uri)) {
				return { uri: w.uri, owner: w.threadId };
			}
		}
		return undefined;
	}

	private _releaseSettled(): void {
		let changed = false;
		for (const [path, uri] of [...this._uris]) {
			if (!this._isInFlight(path) && !this.hasPending(uri)) {
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
