/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { Database } from '@vscode/sqlite3';
import { GENESIS_HASH, chainHash } from '../../common/auditTypes.js';
import { LedgerBody, LedgerRecord, timeOf } from '../../common/egressLedger.js';

export type { LedgerRecord };

export class LedgerStore {

	private constructor(private readonly db: Database) { }

	static async create(dbPath: string): Promise<LedgerStore> {
		// Same loading as LocalAuditStore.create: the CJS package lands on `.default` under ESM.
		const sqlite3 = (await import('@vscode/sqlite3')).default;
		const db: Database = await new Promise((resolve, reject) => {
			const d = new sqlite3.Database(dbPath, (err) => err ? reject(err) : resolve(d));
		});
		const store = new LedgerStore(db);
		await store.run(
			`CREATE TABLE IF NOT EXISTS ledger_records (seq INTEGER PRIMARY KEY, prevHash TEXT, json TEXT, t TEXT)`, []);
		await store.run(`CREATE INDEX IF NOT EXISTS idx_ledger_t ON ledger_records(t)`, []);
		// The meta row is never pruned: it keeps the seq counter and chain head across retention deletes,
		// and created_at is written once when the db is first created.
		await store.run(
			`CREATE TABLE IF NOT EXISTS ledger_meta (id INTEGER PRIMARY KEY CHECK (id = 0), last_seq INTEGER NOT NULL, last_hash TEXT NOT NULL, created_at TEXT NOT NULL)`, []);
		await store.run(
			`INSERT OR IGNORE INTO ledger_meta (id, last_seq, last_hash, created_at) VALUES (0, 0, ?, ?)`, [GENESIS_HASH, new Date().toISOString()]);
		// Where retention pruning stopped: the first surviving record must link to it, so a deleted prefix shows.
		const columns = await store.all<{ name: string }>(`PRAGMA table_info(ledger_meta)`, []);
		if (!columns.some(c => c.name === 'pruned_through_seq')) {
			await store.run(`ALTER TABLE ledger_meta ADD COLUMN pruned_through_seq INTEGER NOT NULL DEFAULT 0`, []);
			await store.run(`ALTER TABLE ledger_meta ADD COLUMN pruned_through_hash TEXT NOT NULL DEFAULT '${GENESIS_HASH}'`, []);
		}
		return store;
	}

	private get<T>(sql: string, params: unknown[]): Promise<T | undefined> {
		return new Promise((resolve, reject) => this.db.get(sql, params, (e, row) => e ? reject(e) : resolve(row as T)));
	}
	private all<T>(sql: string, params: unknown[]): Promise<T[]> {
		return new Promise((resolve, reject) => this.db.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows as T[])));
	}
	private run(sql: string, params: unknown[]): Promise<{ changes: number }> {
		return new Promise((resolve, reject) => this.db.run(sql, params, function (this: { changes: number }, e: Error | null) { e ? reject(e) : resolve({ changes: this.changes }); }));
	}

	private _chain: Promise<unknown> = Promise.resolve();

	private serialized<T>(fn: () => Promise<T>): Promise<T> {
		const result = this._chain.then(fn, fn);
		this._chain = result.then(() => undefined, () => undefined);
		return result;
	}

	append(bodies: LedgerBody[]): Promise<void> {
		if (bodies.length === 0) { return Promise.resolve(); }
		return this.serialized(() => this._append(bodies));
	}

	private async _append(bodies: LedgerBody[]): Promise<void> {
		const meta = await this.get<{ last_seq: number; last_hash: string }>(`SELECT last_seq, last_hash FROM ledger_meta WHERE id = 0`, []);
		let seq = meta?.last_seq ?? 0;
		let hash = meta?.last_hash ?? GENESIS_HASH;
		await this.run('BEGIN', []);
		try {
			for (const body of bodies) {
				seq++;
				// Store the serialized body and hash its round-trip, so append and verifyChain agree byte for byte.
				const json = JSON.stringify(body);
				const prevHash = hash;
				await this.run(`INSERT INTO ledger_records (seq, prevHash, json, t) VALUES (?, ?, ?, ?)`, [seq, prevHash, json, timeOf(body)]);
				hash = chainHash(prevHash, { seq, body: JSON.parse(json) });
			}
			await this.run(`UPDATE ledger_meta SET last_seq = ?, last_hash = ? WHERE id = 0`, [seq, hash]);
			await this.run('COMMIT', []);
		} catch (e) {
			await this.run('ROLLBACK', []).catch(() => undefined);
			throw e;
		}
	}

	/** Contiguous seq range: min seq with t >= from through max seq with t <= to, whatever each record's own t. */
	recordsBetween(fromIso: string, toIso: string): Promise<LedgerRecord[]> {
		return this.serialized(() => this._recordsBetween(fromIso, toIso));
	}

	private async _recordsBetween(fromIso: string, toIso: string): Promise<LedgerRecord[]> {
		const lo = await this.get<{ s: number | null }>(`SELECT MIN(seq) AS s FROM ledger_records WHERE t >= ?`, [fromIso]);
		const hi = await this.get<{ s: number | null }>(`SELECT MAX(seq) AS s FROM ledger_records WHERE t <= ?`, [toIso]);
		if (lo?.s === null || lo?.s === undefined || hi?.s === null || hi?.s === undefined || lo.s > hi.s) { return []; }
		const rows = await this.all<{ seq: number; prevHash: string; json: string }>(
			`SELECT seq, prevHash, json FROM ledger_records WHERE seq BETWEEN ? AND ? ORDER BY seq ASC`, [lo.s, hi.s]);
		return rows.map(r => ({ seq: r.seq, prevHash: r.prevHash, body: JSON.parse(r.json) as LedgerBody }));
	}

	/** Every record with seq > `seq`, in seq order. */
	recordsAfter(seq: number): Promise<LedgerRecord[]> {
		return this.serialized(async () => {
			const rows = await this.all<{ seq: number; prevHash: string; json: string }>(
				`SELECT seq, prevHash, json FROM ledger_records WHERE seq > ? ORDER BY seq ASC`, [seq]);
			return rows.map(r => ({ seq: r.seq, prevHash: r.prevHash, body: JSON.parse(r.json) as LedgerBody }));
		});
	}

	head(): Promise<{ seq: number; hash: string }> {
		return this.serialized(() => this._head());
	}

	private async _head(): Promise<{ seq: number; hash: string }> {
		const meta = await this.get<{ last_seq: number; last_hash: string }>(`SELECT last_seq, last_hash FROM ledger_meta WHERE id = 0`, []);
		return { seq: meta?.last_seq ?? 0, hash: meta?.last_hash ?? GENESIS_HASH };
	}

	/** ISO time the db was first created. Written once; never pruned or changed. */
	async createdAt(): Promise<string> {
		const meta = await this.get<{ created_at: string }>(`SELECT created_at FROM ledger_meta WHERE id = 0`, []);
		return meta!.created_at;
	}

	/** The record hash for `seq`: the next record's prevHash, or the meta head hash for the last one. Undefined if unknown. */
	hashAt(seq: number): Promise<string | undefined> {
		return this.serialized(() => this._hashAt(seq));
	}

	private async _hashAt(seq: number): Promise<string | undefined> {
		const next = await this.get<{ prevHash: string }>(`SELECT prevHash FROM ledger_records WHERE seq = ?`, [seq + 1]);
		if (next) { return next.prevHash; }
		const meta = await this.get<{ last_seq: number; last_hash: string }>(`SELECT last_seq, last_hash FROM ledger_meta WHERE id = 0`, []);
		return meta && seq >= 1 && meta.last_seq === seq ? meta.last_hash : undefined;
	}

	verifyChain(): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }> {
		return this.serialized(() => this._verifyChain());
	}

	private async _verifyChain(): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }> {
		const rows = await this.all<{ seq: number; prevHash: string; json: string }>(
			`SELECT seq, prevHash, json FROM ledger_records ORDER BY seq ASC`, []);
		const meta = await this.get<{ last_seq: number; last_hash: string; pruned_through_seq: number; pruned_through_hash: string }>(
			`SELECT last_seq, last_hash, pruned_through_seq, pruned_through_hash FROM ledger_meta WHERE id = 0`, []);
		if (!meta) { return rows.length === 0 ? { ok: true } : { ok: false, brokenAtSeq: rows[0].seq }; }
		// The first surviving row must follow the last pruned record (or start the chain: seq 1 after GENESIS).
		// An empty table must be exactly what pruning left: otherwise rows were deleted by hand.
		if (rows.length === 0) {
			return meta.last_seq === meta.pruned_through_seq && meta.last_hash === meta.pruned_through_hash
				? { ok: true } : { ok: false, brokenAtSeq: meta.pruned_through_seq + 1 };
		}
		if (rows[0].seq !== meta.pruned_through_seq + 1) { return { ok: false, brokenAtSeq: meta.pruned_through_seq + 1 }; }
		if (rows[0].prevHash !== meta.pruned_through_hash) { return { ok: false, brokenAtSeq: rows[0].seq }; }
		// Pairwise: each row's own hash must equal what the next row (or the meta head, for the last row) recorded.
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const hash = chainHash(row.prevHash, { seq: row.seq, body: JSON.parse(row.json) });
			const next = rows[i + 1];
			if (next) {
				if (next.seq !== row.seq + 1) { return { ok: false, brokenAtSeq: row.seq + 1 }; } // a record in the middle is missing
				if (next.prevHash !== hash) { return { ok: false, brokenAtSeq: row.seq }; }
			} else {
				// Last surviving row: it must be the head, otherwise the tail was truncated.
				if (meta.last_seq !== row.seq) { return { ok: false, brokenAtSeq: row.seq + 1 }; }
				if (meta.last_hash !== hash) { return { ok: false, brokenAtSeq: row.seq }; }
			}
		}
		return { ok: true };
	}

	/**
	 * Deletes the contiguous seq prefix that precedes the first record whose time is >= `iso`
	 * (all records if none is). Bucket times are not monotonic in seq, so a time-only delete could leave
	 * holes. The meta row keeps the chain going and records the last deleted record (`pruned_through_*`),
	 * which verifyChain requires the first surviving record to follow.
	 */
	async pruneOlderThan(iso: string): Promise<number> {
		return this.serialized(async () => {
			const first = await this.get<{ s: number | null }>(`SELECT MIN(seq) AS s FROM ledger_records WHERE t >= ?`, [iso]);
			const last = first?.s === null || first?.s === undefined
				? await this.get<{ seq: number; prevHash: string; json: string }>(`SELECT seq, prevHash, json FROM ledger_records ORDER BY seq DESC LIMIT 1`, [])
				: await this.get<{ seq: number; prevHash: string; json: string }>(`SELECT seq, prevHash, json FROM ledger_records WHERE seq < ? ORDER BY seq DESC LIMIT 1`, [first.s]);
			if (!last) { return 0; }
			const hash = chainHash(last.prevHash, { seq: last.seq, body: JSON.parse(last.json) });
			await this.run('BEGIN', []);
			try {
				const { changes } = await this.run(`DELETE FROM ledger_records WHERE seq <= ?`, [last.seq]);
				await this.run(`UPDATE ledger_meta SET pruned_through_seq = ?, pruned_through_hash = ? WHERE id = 0`, [last.seq, hash]);
				await this.run('COMMIT', []);
				return changes;
			} catch (e) {
				await this.run('ROLLBACK', []).catch(() => undefined);
				throw e;
			}
		});
	}

	close(): Promise<void> {
		return this.serialized(() => new Promise<void>(resolve => this.db.close(() => resolve())));
	}
}
