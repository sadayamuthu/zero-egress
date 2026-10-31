/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';

type Waiter = {
	limit: number;
	priority: boolean;
	start: () => void;
};

/**
 * Limits how many holders of a key run at once. Keys are `model:<providerName>` (LLM requests) and `agents` (background runs).
 * Waiters start in FIFO order, except that priority waiters go ahead of every non-priority waiter.
 * The limit is the one passed by each caller, so a changed setting applies to the next request.
 */
export class SlotQueue extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _active = new Map<string, number>();
	private readonly _waiters = new Map<string, Waiter[]>();

	acquire(key: string, limit: number, opts?: { priority?: boolean; token?: CancellationToken }): Promise<IDisposable> {
		const token = opts?.token;
		if (token?.isCancellationRequested) { return Promise.reject(new CancellationError()); }

		return new Promise<IDisposable>((resolve, reject) => {
			let cancelListener: IDisposable | undefined;
			const waiter: Waiter = {
				limit: Math.max(1, Math.floor(limit) || 1),
				priority: !!opts?.priority,
				start: () => {
					cancelListener?.dispose();
					this._active.set(key, this.active(key) + 1);
					resolve(this._slot(key));
				},
			};

			const queue = this._waiters.get(key) ?? [];
			if (waiter.priority) {
				const firstNormal = queue.findIndex(w => !w.priority);
				queue.splice(firstNormal === -1 ? queue.length : firstNormal, 0, waiter);
			} else {
				queue.push(waiter);
			}
			this._waiters.set(key, queue);

			if (token) {
				cancelListener = token.onCancellationRequested(() => {
					cancelListener?.dispose();
					const q = this._waiters.get(key);
					const idx = q?.indexOf(waiter) ?? -1;
					if (q && idx !== -1) {
						q.splice(idx, 1);
						reject(new CancellationError());
						this._pump(key);
						this._onDidChange.fire();
					}
				});
			}

			this._pump(key);
			this._onDidChange.fire();
		});
	}

	waiting(key: string): number {
		return this._waiters.get(key)?.length ?? 0;
	}

	active(key: string): number {
		return this._active.get(key) ?? 0;
	}

	/** releasing is idempotent: a slot frees its place exactly once */
	private _slot(key: string): IDisposable {
		let released = false;
		return {
			dispose: () => {
				if (released) { return; }
				released = true;
				this._active.set(key, Math.max(0, this.active(key) - 1));
				this._pump(key);
				this._onDidChange.fire();
			}
		};
	}

	/** start waiters from the head of the line while the head's limit allows it */
	private _pump(key: string): void {
		const queue = this._waiters.get(key);
		while (queue && queue.length > 0 && this.active(key) < queue[0].limit) {
			queue.shift()!.start();
		}
		if (queue && queue.length === 0) { this._waiters.delete(key); }
	}
}
