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
// with another chat's pending (or in-flight) folder create or delete above it. Owner keys stay per file.
// Pending changes with no owner block a docked write the same way, reported with the owner UNOWNED: the next chat to
// write the file never takes them over silently.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual, isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ChangeOwners, ClaimResult, UNOWNED } from '../common/changeOwners.js';
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
	 * changes at or under `uri`, or a pending or in-flight folder create or delete above it. Unowned pending changes
	 * there conflict too, with the owner UNOWNED. Otherwise claims `uri` (taking it over from an owner with nothing
	 * pending) and keeps it in flight until the returned disposable is disposed.
	 */
	beginWrite(uri: URI, threadId: string, kind: WriteKind): IDisposable;
	/** Read-only: the chat (or UNOWNED) whose changes would stop `threadId` writing `uri` (the same rule as beginWrite), if any. */
	conflictFor(uri: URI, threadId: string): { owner: string } | undefined;
	/**
	 * Read-only: what to resolve so `threadId` can write `uri`, one blocking chat at a time. That chat's owned paths at
	 * or under `uri` (resolve their diffs and pending ops), and the ids of its pending folder ops above `uri`.
	 * Never selects a third chat's changes: if resolving a blocker would also resolve (or remove) changes another chat
	 * owns, that other chat is reported instead. `preferredOwner` (the chat the card names) is picked when it can be.
	 * Unowned pending changes inside the selection go with it. When the blocker is UNOWNED, the selection is the unowned
	 * pending paths at or under `uri` and the unowned folder ops above it.
	 */
	changesBlocking(uri: URI, threadId: string, preferredOwner?: string): BlockingChanges | undefined;
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

	changesBlocking(uri: URI, threadId: string, preferredOwner?: string): BlockingChanges | undefined {
		const owners = [...new Set(this._conflictsFor(uri, threadId).map(c => c.owner))];
		if (!owners.length) {
			return undefined;
		}
		if (preferredOwner !== undefined && owners.includes(preferredOwner)) {
			owners.splice(owners.indexOf(preferredOwner), 1);
			owners.unshift(preferredOwner);
		}
		// follow "resolving X would touch Y's changes" to a chat whose changes can be resolved alone
		let owner = owners[0];
		const seen = new Set<string>();
		while (!seen.has(owner)) {
			seen.add(owner);
			const selection = this._selectionOf(owner, uri);
			const third = this._thirdChatIn([...selection.uris, ...selection.folders], threadId, owner);
			if (third === undefined) {
				return { owner, uris: selection.uris, opIds: selection.opIds };
			}
			owner = third;
		}
		return { owner, uris: [], opIds: [] }; // changes nested in each other's: nothing can be resolved safely
	}

	/** `owner`'s owned paths at or under `uri`, and its pending ops above `uri` (with their folders) */
	private _selectionOf(owner: string, uri: URI): { uris: URI[]; opIds: number[]; folders: URI[] } {
		const uris = owner === UNOWNED
			? this._unownedPending().filter(u => isEqualOrParent(u, uri))
			: this.ownedUris(owner).filter(u => isEqualOrParent(u, uri));
		const opIds: number[] = [];
		const folders: URI[] = [];
		for (const op of this._pendingFileOpsService.ops) {
			const folder = URI.parse(op.path);
			if ((this.ownerOf(folder) ?? UNOWNED) === owner && isEqualOrParent(uri, folder) && !isEqual(uri, folder)) {
				opIds.push(op.id);
				folders.push(folder);
			}
		}
		return { uris, opIds, folders };
	}

	/** a chat other than `threadId` and `owner` with pending or in-flight changes at or under any of `roots` */
	private _thirdChatIn(roots: URI[], threadId: string, owner: string): string | undefined {
		for (const [path, owned] of this._uris) {
			const other = this._owners.ownerOf(path);
			if (other === undefined || other === threadId || other === owner) {
				continue;
			}
			if (roots.some(r => isEqualOrParent(owned, r)) && (this._isInFlight(path) || this.hasPending(owned))) {
				return other;
			}
		}
		for (const w of this._inFlight) {
			if (w.threadId !== threadId && w.threadId !== owner && roots.some(r => isEqualOrParent(w.uri, r))) {
				return w.threadId;
			}
		}
		return undefined;
	}

	/** every path with pending changes (diff zones, or a pending create or delete) and no owner, each once */
	private _unownedPending(): URI[] {
		const found = new Map<string, URI>();
		for (const [path, ids] of Object.entries(this._editCodeService.diffAreasOfURI)) {
			if (found.has(path) || this._owners.ownerOf(path) !== undefined) {
				continue;
			}
			for (const id of ids ?? []) {
				const area = this._editCodeService.diffAreaOfId[id];
				if (area?.type === 'DiffZone') {
					found.set(path, area._URI ?? URI.file(path));
					break;
				}
			}
		}
		for (const op of this._pendingFileOpsService.ops) {
			const opUri = URI.parse(op.path);
			if (!found.has(opUri.fsPath) && this._owners.ownerOf(opUri.fsPath) === undefined) {
				found.set(opUri.fsPath, opUri);
			}
		}
		return [...found.values()];
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
		return this._conflictsFor(uri, threadId)[0];
	}

	private _conflictsFor(uri: URI, threadId: string): { uri: URI; owner: string }[] {
		const conflicts: { uri: URI; owner: string }[] = [];
		// another chat's pending or in-flight changes at or under uri (the file itself, or inside a folder op's path)
		for (const [path, owned] of this._uris) {
			const owner = this._owners.ownerOf(path);
			if (owner === undefined || owner === threadId || !isEqualOrParent(owned, uri)) {
				continue;
			}
			if (this._isInFlight(path) || this.hasPending(owned)) {
				conflicts.push({ uri: owned, owner });
			}
		}
		// pending changes no chat owns, at or under uri (a write never takes them over silently)
		for (const unowned of this._unownedPending()) {
			if (isEqualOrParent(unowned, uri)) {
				conflicts.push({ uri: unowned, owner: UNOWNED });
			}
		}
		// another chat's (or no chat's) folder create or delete above uri, pending or in flight (any op or write above a
		// path is a folder's). An unowned op at or under uri was reported above
		for (const op of this._pendingFileOpsService.ops) {
			const folder = URI.parse(op.path);
			const owner = this.ownerOf(folder) ?? UNOWNED;
			if (owner !== threadId && isEqualOrParent(uri, folder) && !(owner === UNOWNED && isEqual(uri, folder))) {
				conflicts.push({ uri: folder, owner });
			}
		}
		for (const w of this._inFlight) {
			if (w.kind !== 'edit' && w.threadId !== threadId && isEqualOrParent(uri, w.uri)) {
				conflicts.push({ uri: w.uri, owner: w.threadId });
			}
		}
		return conflicts;
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
