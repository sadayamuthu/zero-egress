/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Agent file creates and deletes that wait for the user's review. Pure state over path strings (the browser
// service uses URI strings, so remote and Windows paths compare with '/'); the browser service
// (browser/pendingFileOpsService.ts) does the disk work these methods return.
// A create has already happened on disk when it is recorded (so the agent can write into the file);
// rejecting it removes the file. A delete has not happened yet; accepting it removes the file.

export type PendingFileOpKind = 'create' | 'delete';

export interface PendingFileOp {
	readonly id: number;
	readonly kind: PendingFileOpKind;
	readonly path: string;
	readonly isFolder: boolean;
	readonly recursive: boolean;
}

/** Work the caller must do on disk. */
export type DiskAction = { type: 'delete'; path: string; recursive: boolean };

const normalize = (path: string) => path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
const isUnder = (path: string, base: string) => path === base || path.startsWith(base + '/');

export class PendingFileOps {
	private _ops: readonly PendingFileOp[] = [];
	private _nextId = 1;

	get ops(): readonly PendingFileOp[] {
		return this._ops;
	}

	opFor(path: string): PendingFileOp | undefined {
		const p = normalize(path);
		return this._ops.find(o => o.path === p);
	}

	/** Called after the file or folder was created on disk. */
	recordCreate(path: string, isFolder: boolean): DiskAction[] {
		const p = normalize(path);
		const existing = this.opFor(p);
		if (existing?.kind === 'delete') {
			// recreating a path that is pending deletion: the original stays, nothing to review
			this._remove(existing.id);
			return [];
		}
		if (!existing) {
			this._ops = [...this._ops, { id: this._nextId++, kind: 'create', path: p, isFolder, recursive: isFolder }];
		}
		return [];
	}

	/** Records a delete; nothing is removed until it is accepted. */
	recordDelete(path: string, recursive: boolean, isFolder: boolean = recursive): DiskAction[] {
		const p = normalize(path);
		const existing = this.opFor(p);
		if (existing?.kind === 'create') {
			// deleting something the agent created and the user never reviewed: undo the create, and anything
			// pending inside it goes with it
			this._ops = this._ops.filter(o => !isUnder(o.path, p));
			return [{ type: 'delete', path: p, recursive: existing.recursive || recursive }];
		}
		if (!existing) {
			this._ops = [...this._ops, { id: this._nextId++, kind: 'delete', path: p, isFolder, recursive }];
		}
		return [];
	}

	/** For undoing a resolve whose disk work failed. */
	snapshot(): readonly PendingFileOp[] {
		return this._ops;
	}

	restore(ops: readonly PendingFileOp[]): void {
		this._ops = [...ops];
	}

	resolve(id: number, behavior: 'accept' | 'reject'): DiskAction[] {
		const op = this._ops.find(o => o.id === id);
		if (!op) {
			return [];
		}
		this._remove(id);
		if (op.kind === 'create') {
			return behavior === 'reject' ? [{ type: 'delete', path: op.path, recursive: op.recursive }] : [];
		}
		if (behavior === 'reject') {
			return [];
		}
		// the folder is going away, so anything pending inside it is moot
		this._ops = this._ops.filter(o => !isUnder(o.path, op.path));
		return [{ type: 'delete', path: op.path, recursive: op.recursive }];
	}

	/** Resolves every op, or only those at or under `underPath`. Never returns a delete covered by another. */
	resolveAll(behavior: 'accept' | 'reject', underPath?: string): DiskAction[] {
		const base = underPath === undefined ? undefined : normalize(underPath);
		const selected = this._ops.filter(o => base === undefined || isUnder(o.path, base));
		const selectedIds = new Set(selected.map(o => o.id));
		this._ops = this._ops.filter(o => !selectedIds.has(o.id));

		// accept: delete the pending deletes; reject: delete the pending creates
		const removing = selected
			.filter(o => o.kind === (behavior === 'accept' ? 'delete' : 'create'))
			.sort((a, b) => a.path.length - b.path.length);
		const actions: DiskAction[] = [];
		for (const op of removing) {
			if (actions.some(a => isUnder(op.path, a.path))) {
				continue;
			}
			actions.push({ type: 'delete', path: op.path, recursive: op.recursive });
		}
		return actions;
	}

	private _remove(id: number): void {
		this._ops = this._ops.filter(o => o.id !== id);
	}
}
