/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Which chat thread owns each file's pending (unreviewed) changes. Pure state over fsPath strings.

export type ClaimResult = { ok: true } | { ok: false; owner: string };

export class ChangeOwners {
	private readonly _owners = new Map<string, string>();

	ownerOf(path: string): string | undefined {
		return this._owners.get(path);
	}

	claim(path: string, threadId: string): ClaimResult {
		const owner = this._owners.get(path);
		if (owner === undefined) {
			this._owners.set(path, threadId);
			return { ok: true };
		}
		return owner === threadId ? { ok: true } : { ok: false, owner };
	}

	transfer(path: string, threadId: string): void {
		this._owners.set(path, threadId);
	}

	release(path: string): void {
		this._owners.delete(path);
	}

	releaseThread(threadId: string): string[] {
		const paths = this.pathsOf(threadId);
		for (const p of paths) {
			this._owners.delete(p);
		}
		return paths;
	}

	pathsOf(threadId: string): string[] {
		const paths: string[] = [];
		for (const [p, t] of this._owners) {
			if (t === threadId) {
				paths.push(p);
			}
		}
		return paths.sort();
	}
}
