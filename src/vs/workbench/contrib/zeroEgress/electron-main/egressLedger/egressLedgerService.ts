/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { LedgerAggregator, LedgerBody } from '../../common/egressLedger.js';
import { LedgerStore } from './ledgerStore.js';

const RETENTION_MS = 400 * 24 * 3600_000;
const HOUR_MS = 3600_000;

export interface EgressLedgerServiceOptions {
	dbPath: string;
	version: string;
	commit: string;
	auditEnabled: boolean;
	expectedSince: { get(): string | undefined; set(iso: string): void };
	now?: () => number;
	flushMs?: number;
	onError?: (message: string, error: unknown) => void;
}

/**
 * Owns the ledger store and the aggregator. Main flushes the aggregator to disk every `flushMs` (60 s) and on shutdown;
 * there is no per-request disk I/O. The aggregator exists from construction so the guard can use it before `open()` resolves.
 */
export class EgressLedgerService {

	static async create(opts: EgressLedgerServiceOptions): Promise<EgressLedgerService> {
		const service = new EgressLedgerService(opts);
		await service.open();
		return service;
	}

	readonly aggregator = new LedgerAggregator();

	private _store: LedgerStore | undefined;
	private _resetSince: string | undefined;
	private _timer: ReturnType<typeof setInterval> | undefined;
	private _pending: LedgerBody[] = [];
	private _auditEnabled: boolean;
	private _queue: Promise<void> = Promise.resolve();
	private _disposed = false;
	private _closed = false;
	private _lastFlushOk = true;
	private _opening: Promise<void> | undefined;
	private readonly _now: () => number;

	constructor(private readonly opts: EgressLedgerServiceOptions) {
		this._now = opts.now ?? Date.now;
		this._auditEnabled = opts.auditEnabled;
	}

	get store(): LedgerStore {
		if (!this._store) { throw new Error('EgressLedgerService is not open'); }
		return this._store;
	}

	open(): Promise<void> {
		return this._opening ??= this._open();
	}

	private async _open(): Promise<void> {
		const store = this._store = await LedgerStore.create(this.opts.dbPath);
		const createdAt = await store.createdAt();
		const iso = this.iso();
		await store.append([
			{ type: 'session_start', time: iso, version: this.opts.version, commit: this.opts.commit },
			{ type: 'audit_state', time: iso, enabled: this._auditEnabled },
		]);

		// A ledger created after the profile's marker means earlier history is gone: report that gap.
		const expected = this.opts.expectedSince.get();
		if (expected === undefined) {
			this.opts.expectedSince.set(createdAt);
		} else if (createdAt > expected) {
			this._resetSince = createdAt;
		}

		await store.pruneOlderThan(new Date(this._now() - RETENTION_MS).toISOString());

		if (this._disposed) { return; } // shutdown began while opening: dispose finishes the job, no timer
		this._timer = setInterval(() => { void this.flush(); }, this.opts.flushMs ?? 60_000);
		this._timer.unref?.();
	}

	/** Set when the ledger was created after `expectedSince`, so the report can say the earlier history is missing. */
	resetSince(): string | undefined {
		return this._resetSince;
	}

	setAuditEnabled(enabled: boolean): void {
		if (enabled === this._auditEnabled) { return; }
		this._auditEnabled = enabled;
		this._pending.push({ type: 'audit_state', time: this.iso(), enabled });
	}

	/** Drains the aggregator and appends it with a heartbeat for the current hour. A failed write drops that batch and is logged. */
	flush(): Promise<void> {
		if (this._closed) { return Promise.resolve(); }
		const run = this._queue.then(() => this._flush());
		this._queue = run.catch(() => undefined);
		return run;
	}

	private async _flush(): Promise<void> {
		if (!this._store) { return; }
		const hour = new Date(Math.floor(this._now() / HOUR_MS) * HOUR_MS).toISOString();
		const kept = this._pending;
		const bodies: LedgerBody[] = [...kept, ...this.aggregator.drain(), { type: 'heartbeat', hour }];
		this._pending = [];
		try {
			await this._store.append(bodies);
			this._lastFlushOk = true;
		} catch (e) {
			this._lastFlushOk = false;
			this._pending = [...kept, ...this._pending]; // counts are dropped; audit_state and session_end are kept for the next attempt
			this.opts.onError?.('[ZeroEgress] ledger flush failed; its counts are dropped', e);
		}
	}

	async dispose(): Promise<void> {
		if (this._disposed) { return; }
		this._disposed = true;
		if (this._timer) { clearInterval(this._timer); this._timer = undefined; }
		try { await this._opening; } catch { /* open failed and was logged by the caller; nothing to close */ }
		const store = this._store;
		if (!store) { return; }
		this._pending.push({ type: 'session_end', time: this.iso() });
		await this.flush();
		if (!this._lastFlushOk) { await this.flush(); } // one retry, so a transient error doesn't look like a crash
		this._closed = true;
		try {
			await store.close();
		} catch (e) {
			this.opts.onError?.('[ZeroEgress] ledger close failed', e);
		}
	}

	private iso(): string {
		return new Date(this._now()).toISOString();
	}
}
