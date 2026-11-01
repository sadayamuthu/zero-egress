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

export function imageTooLargeNote(name: string): string {
	return `[Image ${name} not sent: it is larger than 5 MB.]`;
}

export function imageMissingNote(name: string): string {
	return `[Image ${name} not sent: the file is missing.]`;
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
