/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { LLMChatMessage, OpenAIUserPart } from './sendLLMMessageTypes.js';

export const MAX_IMAGES_PER_MESSAGE = 4;

export function toOpenAIUserContent(text: string, images: { mime: string; base64: string }[]): string | OpenAIUserPart[] {
	if (images.length === 0) return text;
	return [
		{ type: 'text', text },
		...images.slice(0, MAX_IMAGES_PER_MESSAGE).map((i): OpenAIUserPart => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } })),
	];
}

export function imageNote(name: string): string {
	return `[Image ${name} not sent: this model can't read images.]`;
}

export type ImageNoteReason = 'no-vision' | 'too-large' | 'missing' | 'sent-earlier' | 'format' | 'cap';

/** The text that stands in for an image that is not sent. */
export function noteForImage(name: string, reason: ImageNoteReason): string {
	switch (reason) {
		case 'no-vision': return imageNote(name);
		case 'too-large': return `[Image ${name} not sent: it is larger than 5 MB.]`;
		case 'missing': return `[Image ${name} not sent: the file is missing.]`;
		case 'sent-earlier': return `[Image ${name} sent earlier.]`;
		case 'format': return `[Image ${name} not sent: this model format can't carry images here.]`;
		case 'cap': return `[Image ${name} not sent: at most ${MAX_IMAGES_PER_MESSAGE} images per message.]`;
	}
}

/** Only the latest user message (of the given user message indices) carries image bytes. */
export function imageMessageIndex(userMessageIdxs: number[]): number | undefined {
	return userMessageIdxs.length ? userMessageIdxs[userMessageIdxs.length - 1] : undefined;
}

/** Joins consecutive user messages' images; those over the per-message cap become notes. */
export function mergeUserImages<T extends { name: string }>(existing: T[], added: T[]): { images: T[]; notes: string[] } {
	const all = [...existing, ...added];
	return {
		images: all.slice(0, MAX_IMAGES_PER_MESSAGE),
		notes: all.slice(MAX_IMAGES_PER_MESSAGE).map(i => noteForImage(i.name, 'cap')),
	};
}

/** Puts the system text before a first user message, keeping any image parts. */
export function prefixUserContent(content: string | OpenAIUserPart[], prefix: string): string | OpenAIUserPart[] {
	if (typeof content === 'string') return prefix + content;
	const first = content[0];
	if (first && first.type === 'text') return [{ type: 'text', text: prefix + first.text }, ...content.slice(1)];
	return [{ type: 'text', text: prefix }, ...content];
}

/** Deep copy for the audit log: image data URLs never leave the message path. */
export function redactImagesForAudit(messages: LLMChatMessage[]): LLMChatMessage[] {
	return messages.map(m => {
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) return JSON.parse(JSON.stringify(m)) as LLMChatMessage;
		const copy = JSON.parse(JSON.stringify(m)) as { content: any[] };
		for (const part of copy.content) {
			if (part && part.type === 'image_url' && part.image_url) part.image_url.url = '[image omitted]';
		}
		return copy as unknown as LLMChatMessage;
	});
}
