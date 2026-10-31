/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { linesDiffComputers } from '../../../../editor/common/diff/linesDiffComputers.js';

/** Line numbers are 0-based. */
export interface Hunk { baseStart: number; baseLines: string[]; agentStart: number; agentLines: string[] }

export type HunkState =
	| { status: 'clean'; hunk: Hunk; currentStart: number }
	| { status: 'conflict'; hunk: Hunk; currentStart: number; currentEnd: number; currentLines: string[]; agentVersion: string[] };

export type FileKind = 'modified' | 'added' | 'deleted' | 'binary';

export interface FileReview { path: string; kind: FileKind; hunks: HunkState[]; added: number; removed: number; fileConflict: boolean }

/** Empty text is zero lines; a trailing newline does not add an empty last line. */
export function splitLines(text: string): string[] {
	if (text === '') {
		return [];
	}
	const lines = text.split(/\r?\n/);
	if (text.endsWith('\n')) {
		lines.pop();
	}
	return lines;
}

/**
 * Whether two texts are the same for review: both absent, or both present with equal lines. A missing trailing newline and
 * CRLF vs LF are not differences, since no hunk can show them.
 */
export function linesMatch(a: string | null, b: string | null): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	if (a === b) {
		return true;
	}
	const x = splitLines(a);
	const y = splitLines(b);
	return x.length === y.length && x.every((line, i) => line === y[i]);
}

/**
 * Decodes a file for review. A UTF-8 BOM is stripped (`bom` says it was there, so a write can put it back). Bytes that are not
 * valid UTF-8 give `undefined`: such a file is reviewed as binary, so it is never decoded lossily and written back.
 */
export function decodeReviewText(bytes: Uint8Array): { text: string; bom: boolean } | undefined {
	const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	try {
		return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes), bom };
	} catch {
		return undefined;
	}
}

/** Lines with their line terminators. */
function lineChunks(text: string): string[] {
	return text === '' ? [] : text.split(/(?<=\n)/);
}

/**
 * The smallest whole-line replacement turning `oldText` into `newText`: replace `oldText.slice(start, end)` with `text`.
 * Lines shared at the start and at the end are left alone.
 */
export function minimalEdit(oldText: string, newText: string): { start: number; end: number; text: string } {
	const a = lineChunks(oldText);
	const b = lineChunks(newText);
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
		suffix++;
	}
	const start = a.slice(0, prefix).reduce((n, l) => n + l.length, 0);
	const end = oldText.length - a.slice(a.length - suffix).reduce((n, l) => n + l.length, 0);
	return { start, end, text: b.slice(prefix, b.length - suffix).join('') };
}

interface LineChange { baseStart: number; baseEnd: number; delta: number }

function diffChanges(a: string[], b: string[]): LineChange[] {
	const diff = linesDiffComputers.getDefault().computeDiff(a, b, { ignoreTrimWhitespace: false, maxComputationTimeMs: 2000, computeMoves: false });
	return diff.changes.map(c => ({
		baseStart: c.original.startLineNumber - 1,
		baseEnd: c.original.endLineNumberExclusive - 1,
		delta: c.modified.length - c.original.length,
	}));
}

export function computeHunks(base: string, agent: string): Hunk[] {
	const a = splitLines(base);
	const b = splitLines(agent);
	const diff = linesDiffComputers.getDefault().computeDiff(a, b, { ignoreTrimWhitespace: false, maxComputationTimeMs: 2000, computeMoves: false });
	return diff.changes.map(c => ({
		baseStart: c.original.startLineNumber - 1,
		baseLines: a.slice(c.original.startLineNumber - 1, c.original.endLineNumberExclusive - 1),
		agentStart: c.modified.startLineNumber - 1,
		agentLines: b.slice(c.modified.startLineNumber - 1, c.modified.endLineNumberExclusive - 1),
	}));
}

export function classifyHunk(hunk: Hunk, base: string, current: string): HunkState {
	const baseLines = splitLines(base);
	const currentLines = splitLines(current);
	const changes = diffChanges(baseLines, currentLines);

	let lo = hunk.baseStart;
	let hi = hunk.baseStart + hunk.baseLines.length;
	// Overlapping or directly adjacent user changes join the region; repeat until it stops growing.
	const touching = new Set<LineChange>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const c of changes) {
			if (!touching.has(c) && c.baseStart <= hi && c.baseEnd >= lo) {
				touching.add(c);
				lo = Math.min(lo, c.baseStart);
				hi = Math.max(hi, c.baseEnd);
				grew = true;
			}
		}
	}

	let before = 0;
	for (const c of changes) {
		if (!touching.has(c) && c.baseEnd < lo) {
			before += c.delta;
		}
	}

	if (touching.size === 0) {
		return { status: 'clean', hunk, currentStart: hunk.baseStart + before };
	}

	let inside = 0;
	for (const c of touching) {
		inside += c.delta;
	}
	const currentStart = lo + before;
	const currentEnd = hi + before + inside;
	return {
		status: 'conflict',
		hunk,
		currentStart,
		currentEnd,
		currentLines: currentLines.slice(currentStart, currentEnd),
		agentVersion: [
			...baseLines.slice(lo, hunk.baseStart),
			...hunk.agentLines,
			...baseLines.slice(hunk.baseStart + hunk.baseLines.length, hi),
		],
	};
}

/** Replaces `removeCount` lines at `start`, keeping the text's line ending and trailing-newline state. */
export function replaceLines(text: string, start: number, removeCount: number, insert: string[]): string {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const trailing = text === '' ? true : text.endsWith('\n');
	const lines = splitLines(text);
	lines.splice(start, removeCount, ...insert);
	return lines.length === 0 ? '' : lines.join(eol) + (trailing ? eol : '');
}

export function reviewFile(path: string, base: string | null, agent: string | null, current: string | null, isBinary: boolean): FileReview {
	const review = (kind: FileKind, hunks: HunkState[], added: number, removed: number, fileConflict: boolean): FileReview =>
		({ path, kind, hunks, added, removed, fileConflict });

	if (isBinary) {
		return review('binary', [], 0, 0, false);
	}

	if (base === null && agent !== null) {
		const agentLines = splitLines(agent);
		const hunk: Hunk = { baseStart: 0, baseLines: [], agentStart: 0, agentLines };
		if (current === null) {
			return review('added', [{ status: 'clean', hunk, currentStart: 0 }], agentLines.length, 0, false);
		}
		if (current === agent) {
			return review('added', [], agentLines.length, 0, false);
		}
		return review('added', [], agentLines.length, 0, true);
	}

	if (base !== null && agent === null) {
		const baseLines = splitLines(base);
		const hunk: Hunk = { baseStart: 0, baseLines, agentStart: 0, agentLines: [] };
		if (current === null) {
			return review('deleted', [], 0, baseLines.length, false);
		}
		if (current === base) {
			return review('deleted', [{ status: 'clean', hunk, currentStart: 0 }], 0, baseLines.length, false);
		}
		return review('deleted', [], 0, baseLines.length, true);
	}

	if (base === null || agent === null) {
		return review('modified', [], 0, 0, false);
	}

	const hunks = computeHunks(base, agent);
	const added = hunks.reduce((n, h) => n + h.agentLines.length, 0);
	const removed = hunks.reduce((n, h) => n + h.baseLines.length, 0);
	if (current === null) {
		return review('modified', [], added, removed, true);
	}
	return review('modified', hunks.map(h => classifyHunk(h, base, current)), added, removed, false);
}

export function acceptHunk(s: HunkState, base: string, current: string): { base: string; current: string } {
	const { hunk } = s;
	const newBase = replaceLines(base, hunk.baseStart, hunk.baseLines.length, hunk.agentLines);
	if (s.status === 'clean') {
		return { base: newBase, current: replaceLines(current, s.currentStart, hunk.baseLines.length, hunk.agentLines) };
	}
	return { base: newBase, current: replaceLines(current, s.currentStart, s.currentEnd - s.currentStart, s.agentVersion) };
}

/** The agent text with the hunk reverted. "Keep mine" uses this too. */
export function rejectHunk(hunk: Hunk, agent: string): string {
	return replaceLines(agent, hunk.agentStart, hunk.agentLines.length, hunk.baseLines);
}
