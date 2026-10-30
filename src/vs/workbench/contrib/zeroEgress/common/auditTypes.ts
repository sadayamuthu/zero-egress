/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';

export type AuditOutcome = 'completed' | 'aborted' | 'error';

export interface AuditWorkspace {
	folderUri: string | null;
	repoName: string | null;
	gitRemote: string | null;
	gitBranch: string | null;
	gitCommit: string | null;
}

export interface AuditRecord {
	seq: number;
	id: string;
	prevHash: string;
	timestamp: string;
	machineId: string;
	userId: string;
	appVersion: string;
	zeroEgressVersion: string;
	workspace: AuditWorkspace;
	provider: string;
	modelName: string;
	chatMode: string | null;
	request: { systemPrompt: string; messages: unknown[]; tools: unknown[] };
	response: { text: string; toolCalls: unknown[]; finishReason: string | null };
	outcome: AuditOutcome;
	usage: { inputTokens: number; outputTokens: number; costUsd: number };
	timing: { startedAt: string; durationMs: number };
	error: string | null;
}

export interface IAuditConfig {
	enabled: boolean;
	endpointUrl: string;
	authHeader: string;
	batchSize: number;
	flushIntervalMs: number;
	maxLocalRetentionDays: number;
}

export const GENESIS_HASH = '0'.repeat(64);

// Deterministic JSON: sort object keys recursively so hashing is stable across key insertion order.
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

export function chainHash(prevHash: string, body: unknown): string {
	return createHash('sha256').update(prevHash).update(stableStringify(body)).digest('hex');
}

export function computeRecordHash(prevHash: string, record: Omit<AuditRecord, 'prevHash'>): string {
	return chainHash(prevHash, record);
}
