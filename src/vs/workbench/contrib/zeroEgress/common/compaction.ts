/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Compacting a chat: the earlier turns are replaced, in what the model sees, by one summary message. The messages
// themselves stay in the thread (the user still sees them); `uptoIdx` marks where the summary ends.

import type { ChatMessage } from './chatThreadServiceTypes.js';

export type Compaction = { summary: string; uptoIdx: number; at: string };

export const COMPACT_SYSTEM_PROMPT = 'Summarize this conversation between a user and a coding agent so the agent can continue the work. Keep: the goal, decisions made, files changed and why, commands run and their results, open problems, and the next step. Plain text, at most 300 words.';

const MAX_CHARS_PER_MESSAGE = 2000;

/** the index of the second-to-last user message, so the last two turns stay whole; null with fewer than 3 user messages */
export function compactionCut(messages: ChatMessage[]): number | null {
	const userIdxs: number[] = [];
	messages.forEach((m, i) => { if (m.role === 'user') { userIdxs.push(i); } });
	if (userIdxs.length < 3) { return null; }
	return userIdxs[userIdxs.length - 2];
}

/** what the model sees: messages[0..uptoIdx) become one summary message */
export function applyCompaction(messages: ChatMessage[], c: Compaction | undefined): ChatMessage[] {
	if (!c || c.uptoIdx > messages.length) { return messages; }
	const summary: ChatMessage = {
		role: 'user',
		content: 'Summary of the earlier conversation:\n' + c.summary,
		displayContent: '',
		selections: null,
		state: { stagingSelections: [], isBeingEdited: false },
	};
	return [summary, ...messages.slice(c.uptoIdx)];
}

/** the compaction that survives a cut leaving `newLength` messages: none once the cut reaches into the summarized part */
export function compactionAfterCut(c: Compaction | undefined, newLength: number): Compaction | undefined {
	if (!c || newLength <= c.uptoIdx) { return undefined; }
	return c;
}

const trim = (s: string) => s.length > MAX_CHARS_PER_MESSAGE ? s.slice(0, MAX_CHARS_PER_MESSAGE) + '…' : s;

const chunksOf = (messages: ChatMessage[]): string[] => {
	const lines: string[] = [];
	for (const m of messages) {
		if (m.role === 'user') { lines.push('USER: ' + trim(m.content || m.displayContent)); }
		else if (m.role === 'assistant') { lines.push('ASSISTANT: ' + trim(m.displayContent)); }
		else if (m.role === 'tool') { lines.push(`TOOL ${m.name}: ` + trim(m.content)); }
	}
	return lines;
};

/** the transcript sent to the model to summarize: "USER: …" / "ASSISTANT: …" / "TOOL <name>: …", each trimmed */
export function compactionTranscript(messages: ChatMessage[]): string {
	return chunksOf(messages).join('\n\n');
}

/**
 * What a new summary is written from: the previous summary (whole) and the turns after it up to `cut`. Over
 * `budgetChars`, the oldest turns are dropped first, so the newest work always reaches the summary.
 */
export function compactionInput(messages: ChatMessage[], cut: number, prev: Compaction | undefined, budgetChars: number): string {
	const from = prev && prev.uptoIdx <= cut ? prev.uptoIdx : 0;
	const head = prev && prev.uptoIdx <= cut ? 'Previous summary:\n' + prev.summary : undefined;
	const chunks = chunksOf(messages.slice(from, cut));
	let used = head === undefined ? 0 : head.length;
	const kept: string[] = [];
	for (let i = chunks.length - 1; i >= 0; i--) {
		const cost = chunks[i].length + (used > 0 ? 2 : 0);
		if (kept.length > 0 && used + cost > budgetChars) { break; }
		kept.unshift(chunks[i]);
		used += cost;
	}
	return (head === undefined ? kept : [head, ...kept]).join('\n\n');
}

/** a summary computed for `messages[0..cut)` may be stored only if the chat still holds the same message at `cut` */
export function compactionStillValid(messages: ChatMessage[], cut: number, messageAtCut: ChatMessage | undefined): boolean {
	return messages.length > cut && messages[cut] === messageAtCut;
}
