/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { AuditRecord, AuditWorkspace, AuditOutcome, IAuditConfig } from '../../common/auditTypes.js';
import { LocalAuditStore } from './localAuditStore.js';
import { IAuditForwarder } from './auditForwarder.js';

export interface BeginParams {
	requestId: string;
	provider: string;
	modelName: string;
	chatMode: string | null;
	systemPrompt: string;
	messages: unknown[];
	tools: unknown[];
	workspace: AuditWorkspace;
	identity: { machineId: string; userId: string; appVersion: string; zeroEgressVersion: string };
	startedAtMs: number;
	nowIso: string;
}

export interface FinalizeParams {
	requestId: string;
	outcome: AuditOutcome;
	text: string;
	toolCalls: unknown[];
	finishReason: string | null;
	usage: { inputTokens: number; outputTokens: number; costUsd: number };
	error: string | null;
	endedAtMs: number;
}

export interface IAuditMainService {
	readonly _serviceBrand: undefined;
	readonly isEnabled: boolean;
	begin(p: BeginParams): void;
	appendText(requestId: string, fullText: string): void;
	finalize(p: FinalizeParams): Promise<void>;
	flushForwarder(): Promise<void>;
	pruneRetention(nowMs: number): Promise<number>;
}

// Fallback used when the audit pipeline fails to initialize (e.g. sqlite dynamic-import or
// DB open failure). Lives with the service so it stays in sync with IAuditMainService. Chat
// must continue even when audit storage is unavailable — every method is a safe no-op.
export function createDisabledAuditService(): IAuditMainService {
	return {
		_serviceBrand: undefined,
		isEnabled: false,
		begin() { /* no-op */ },
		appendText() { /* no-op */ },
		async finalize() { /* no-op */ },
		async flushForwarder() { /* no-op */ },
		async pruneRetention() { return 0; },
	};
}

interface InFlight extends BeginParams { latestText: string }

export class AuditMainService implements IAuditMainService {
	declare readonly _serviceBrand: undefined;
	private readonly inFlight = new Map<string, InFlight>();

	constructor(
		private readonly config: IAuditConfig,
		private readonly store: LocalAuditStore,
		private readonly forwarder: IAuditForwarder,
		private readonly logError: (msg: string, e?: unknown) => void,
	) { }

	get isEnabled(): boolean { return this.config.enabled === true; }

	begin(p: BeginParams): void {
		if (!this.isEnabled) return;
		this.inFlight.set(p.requestId, { ...p, latestText: '' });
	}

	appendText(requestId: string, fullText: string): void {
		if (!this.isEnabled) return;
		const entry = this.inFlight.get(requestId);
		if (entry) entry.latestText = fullText;
	}

	async finalize(p: FinalizeParams): Promise<void> {
		if (!this.isEnabled) return;
		const entry = this.inFlight.get(p.requestId);
		if (!entry) return;
		this.inFlight.delete(p.requestId);

		const body: Omit<AuditRecord, 'seq' | 'prevHash'> = {
			id: randomUUID(),
			timestamp: entry.nowIso,
			machineId: entry.identity.machineId,
			userId: entry.identity.userId,
			appVersion: entry.identity.appVersion,
			zeroEgressVersion: entry.identity.zeroEgressVersion,
			workspace: entry.workspace,
			provider: entry.provider,
			modelName: entry.modelName,
			chatMode: entry.chatMode,
			request: { systemPrompt: entry.systemPrompt, messages: entry.messages, tools: entry.tools },
			response: { text: p.text || entry.latestText, toolCalls: p.toolCalls, finishReason: p.finishReason },
			outcome: p.outcome,
			usage: p.usage,
			timing: { startedAt: entry.nowIso, durationMs: p.endedAtMs - entry.startedAtMs },
			error: p.error,
		};

		try {
			await this.store.append(body);
		} catch (e) {
			this.logError('Failed to write audit record to local store', e);
			return;
		}
		// Fire-and-forget forward; never let it reject into the caller.
		this.flushForwarder().catch(e => this.logError('Audit forward flush failed', e));
	}

	private _flushInFlight: Promise<void> | null = null;

	flushForwarder(): Promise<void> {
		if (!this.isEnabled) return Promise.resolve();
		// Single-in-flight guard: concurrent triggers (periodic interval + finalize) coalesce onto the same
		// run, so a slow/hung collector can't spawn overlapping sends that re-deliver the same unmarked rows.
		if (this._flushInFlight) return this._flushInFlight;
		const run = (async () => {
			try {
				const pending = await this.store.getUnforwarded(this.config.batchSize);
				if (pending.length === 0) return;
				const result = await this.forwarder.send(pending);
				if (result.ok) await this.store.markForwarded(pending.map(r => r.id));
			} catch (e) {
				this.logError('Audit forwarder error', e);
			}
		})();
		this._flushInFlight = run.finally(() => { this._flushInFlight = null; });
		return this._flushInFlight;
	}

	async pruneRetention(nowMs: number): Promise<number> {
		if (!this.isEnabled) return 0;
		const cutoffIso = new Date(nowMs - this.config.maxLocalRetentionDays * 24 * 3600 * 1000).toISOString();
		try {
			return await this.store.pruneForwardedOlderThan(cutoffIso);
		} catch (e) {
			this.logError('Audit retention prune failed', e);
			return 0;
		}
	}
}
