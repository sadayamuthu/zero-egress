/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { Database } from '@vscode/sqlite3';
import { AuditRecord, GENESIS_HASH, computeRecordHash } from '../../common/auditTypes.js';

export class LocalAuditStore {

	private constructor(private readonly db: Database) { }

	static async create(dbPath: string): Promise<LocalAuditStore> {
		// This package is built as CommonJS but the workbench compiles to ESM, so it must be loaded via
		// dynamic import (the CJS export lands on `.default`) — same pattern as storage.ts's sqlite3 usage.
		const sqlite3 = (await import('@vscode/sqlite3')).default;
		const db: Database = await new Promise((resolve, reject) => {
			const d = new sqlite3.Database(dbPath, (err) => err ? reject(err) : resolve(d));
		});
		const store = new LocalAuditStore(db);
		await store.run(
			`CREATE TABLE IF NOT EXISTS audit_records (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT UNIQUE,
				prevHash TEXT,
				timestamp TEXT,
				json TEXT,
				forwarded INTEGER DEFAULT 0
			)`, []);
		// Meta table holds the per-machine high-water mark (last_seq + last_hash). It is NEVER pruned,
		// so retention deletes of audit_records can't rewind the seq counter or restart the hash chain.
		await store.run(
			`CREATE TABLE IF NOT EXISTS audit_meta (id INTEGER PRIMARY KEY CHECK (id = 0), last_seq INTEGER NOT NULL, last_hash TEXT NOT NULL)`, []);
		// FIM/autocomplete is high-volume; index the forwarded/seq lookup so getUnforwarded doesn't full-scan.
		await store.run(
			`CREATE INDEX IF NOT EXISTS idx_audit_forwarded_seq ON audit_records(forwarded, seq)`, []);
		// Seed the meta row exactly once. For a fresh db -> (0, GENESIS). For an existing db being migrated,
		// derive the high-water mark from the current last row so the chain continues from where it left off.
		const existingMeta = await store.get<{ id: number }>(`SELECT id FROM audit_meta WHERE id = 0`, []);
		if (!existingMeta) {
			const lastRow = await store.get<{ seq: number; prevHash: string; json: string }>(
				`SELECT seq, prevHash, json FROM audit_records ORDER BY seq DESC LIMIT 1`, []);
			let lastSeq = 0;
			let lastHash = GENESIS_HASH;
			if (lastRow) {
				lastSeq = lastRow.seq;
				const { prevHash: _omit, ...bodyForHash } = JSON.parse(lastRow.json) as AuditRecord;
				lastHash = computeRecordHash(lastRow.prevHash, bodyForHash);
			}
			await store.run(`INSERT INTO audit_meta (id, last_seq, last_hash) VALUES (0, ?, ?)`, [lastSeq, lastHash]);
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

	private _appendChain: Promise<unknown> = Promise.resolve();

	append(bodyWithoutSeqHash: Omit<AuditRecord, 'seq' | 'prevHash'>): Promise<AuditRecord> {
		const result = this._appendChain.then(
			() => this._appendImpl(bodyWithoutSeqHash),
			() => this._appendImpl(bodyWithoutSeqHash), // proceed even if a prior append rejected
		);
		// keep the chain alive regardless of this call's outcome; swallow to avoid unhandledRejection
		this._appendChain = result.then(() => undefined, () => undefined);
		return result;
	}

	private async _appendImpl(bodyWithoutSeqHash: Omit<AuditRecord, 'seq' | 'prevHash'>): Promise<AuditRecord> {
		// Read the high-water mark from the never-pruned meta row so seq + chain survive a full prune.
		// This read+update happens inside the serialized _appendImpl, so concurrent appends stay ordered.
		const meta = await this.get<{ last_seq: number; last_hash: string }>(
			`SELECT last_seq, last_hash FROM audit_meta WHERE id = 0`, []);
		const lastSeq = meta?.last_seq ?? 0;
		const lastHash = meta?.last_hash ?? GENESIS_HASH;
		const seq = lastSeq + 1;
		const prevHash = lastHash; // chain from the persisted last hash, which survives a retention prune
		const record: AuditRecord = { ...bodyWithoutSeqHash, seq, prevHash };
		// Serialize once and reuse the SAME json string for both the INSERT and the hash below. JSON.stringify
		// drops nested undefined-valued keys, so hashing the live `record` would diverge from verifyChain (which
		// hashes JSON.parse(row.json)). Hashing the round-tripped body guarantees append/verify are byte-identical.
		const json = JSON.stringify(record);
		await this.run(
			`INSERT INTO audit_records (seq, id, prevHash, timestamp, json, forwarded) VALUES (?, ?, ?, ?, ?, 0)`,
			[seq, record.id, record.prevHash, record.timestamp, json]);
		// newLastHash is this record's stored body (with seq, without prevHash) hashed under its prevHash —
		// computed from the same round-tripped json verifyChain uses, so append and verify stay in lockstep.
		const { prevHash: _omit, ...bodyForHash } = JSON.parse(json) as AuditRecord;
		const newLastHash = computeRecordHash(prevHash, bodyForHash);
		await this.run(`UPDATE audit_meta SET last_seq = ?, last_hash = ? WHERE id = 0`, [seq, newLastHash]);
		return record;
	}

	async getUnforwarded(limit: number): Promise<AuditRecord[]> {
		const rows = await this.all<{ json: string }>(
			`SELECT json FROM audit_records WHERE forwarded = 0 ORDER BY seq ASC LIMIT ?`, [limit]);
		return rows.map(r => JSON.parse(r.json) as AuditRecord);
	}

	async markForwarded(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const placeholders = ids.map(() => '?').join(',');
		await this.run(`UPDATE audit_records SET forwarded = 1 WHERE id IN (${placeholders})`, ids);
	}

	async pruneForwardedOlderThan(cutoffIso: string): Promise<number> {
		const res = await this.run(`DELETE FROM audit_records WHERE forwarded = 1 AND timestamp < ?`, [cutoffIso]);
		return res.changes;
	}

	async verifyChain(): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }> {
		const rows = await this.all<{ seq: number; prevHash: string; json: string }>(
			`SELECT seq, prevHash, json FROM audit_records ORDER BY seq ASC`, []);
		// Verify PAIRWISE continuity among the present rows only. We must NOT assume the earliest surviving
		// row chains from GENESIS: after a retention prune its prevHash references an already-deleted record.
		// A fresh store's first row still validates because it really does carry GENESIS from the seeded meta.
		for (let i = 1; i < rows.length; i++) {
			const prev = rows[i - 1];
			const { prevHash: _omit, ...prevBody } = JSON.parse(prev.json) as AuditRecord;
			const expectedPrevForNext = computeRecordHash(prev.prevHash, prevBody);
			if (rows[i].prevHash !== expectedPrevForNext) return { ok: false, brokenAtSeq: rows[i].seq };
		}
		return { ok: true };
	}

	// Test-only: corrupt a stored record's json without touching its prevHash, to exercise verifyChain.
	async __tamperForTest(seq: number, responseOverride: { text: string }): Promise<void> {
		const row = await this.get<{ json: string }>(`SELECT json FROM audit_records WHERE seq = ?`, [seq]);
		if (!row) return;
		const parsed = JSON.parse(row.json) as AuditRecord;
		parsed.response.text = responseOverride.text;
		await this.run(`UPDATE audit_records SET json = ? WHERE seq = ?`, [JSON.stringify(parsed), seq]);
	}

	dispose(): Promise<void> {
		return new Promise((resolve) => this.db.close(() => resolve()));
	}
}
