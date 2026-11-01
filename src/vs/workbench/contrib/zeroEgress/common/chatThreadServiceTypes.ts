/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ZeroEgressFileSnapshot } from './editCodeServiceTypes.js';
import { AnthropicReasoning, RawToolParamsObj } from './sendLLMMessageTypes.js';
import { TokenUsage } from './tokenUsage.js';
import { ToolCallParams, ToolName, ToolResult } from './toolsServiceTypes.js';

export type ToolMessage<T extends ToolName> = {
	role: 'tool';
	content: string; // give this result to LLM (string of value)
	id: string;
	rawParams: RawToolParamsObj;
	mcpServerName: string | undefined; // the server name at the time of the call
} & (
		// in order of events:
		| { type: 'invalid_params', result: null, name: T, refused?: true } // `refused`: the run's tool policy disallows the tool; it carries no params

		// params were validated, awaiting user. `conflict`: the path has another docked chat's unreviewed changes (shown as
		// the conflict card, never auto-approved); `uri` is the tool's target, `ownerThreadId` the chat that owns those changes,
		// or UNOWNED ('unowned', common/changeOwners.ts) when no chat owns them. The card treats an id with no thread
		// (UNOWNED, or a chat deleted since) as "made outside this chat"
		| { type: 'tool_request', result: null, name: T, params: ToolCallParams<T>, conflict?: { uri: URI; ownerThreadId: string } }

		| { type: 'running_now', result: null, name: T, params: ToolCallParams<T>, }

		| { type: 'tool_error', result: string, name: T, params: ToolCallParams<T>, } // error when tool was running
		| { type: 'success', result: Awaited<ToolResult<T>>, name: T, params: ToolCallParams<T>, }
		| { type: 'rejected', result: null, name: T, params: ToolCallParams<T> }
	) // user rejected

export type DecorativeCanceledTool = {
	role: 'interrupted_streaming_tool';
	name: ToolName;
	mcpServerName: string | undefined; // the server name at the time of the call
}


// checkpoints
export type CheckpointEntry = {
	role: 'checkpoint';
	type: 'user_edit' | 'tool_edit';
	zeroEgressFileSnapshotOfURI: { [fsPath: string]: ZeroEgressFileSnapshot | undefined };

	userModifications: {
		zeroEgressFileSnapshotOfURI: { [fsPath: string]: ZeroEgressFileSnapshot | undefined };
	};
}


// WARNING: changing this format is a big deal!!!!!! need to migrate old format to new format on users' computers so people don't get errors.
export type ChatMessage =
	| {
		role: 'user';
		content: string; // content displayed to the LLM on future calls - allowed to be '', will be replaced with (empty)
		displayContent: string; // content displayed to user  - allowed to be '', will be ignored
		selections: StagingSelectionItem[] | null; // the user's selection
		state: {
			stagingSelections: StagingSelectionItem[];
			isBeingEdited: boolean;
		}
	} | {
		role: 'assistant';
		displayContent: string; // content received from LLM  - allowed to be '', will be replaced with (empty)
		reasoning: string; // reasoning from the LLM, used for step-by-step thinking
		reasoningMs?: number; // how long the model reasoned (first reasoning token to the first answer token or the end); missing in older chats

		anthropicReasoning: AnthropicReasoning[] | null; // anthropic reasoning
		usage?: TokenUsage; // token counts from the provider; missing in older chats
	}
	| ToolMessage<ToolName>
	| DecorativeCanceledTool
	| CheckpointEntry


// one of the square items that indicates a selection in a chat bubble
export type StagingSelectionItem = {
	type: 'File';
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'CodeSelection';
	range: [number, number];
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'Folder';
	uri: URI;
	language?: undefined;
	state?: undefined;
}


// a link to a symbol (an underlined link to a piece of code)
export type CodespanLocationLink = {
	uri: URI, // we handle serialization for this
	displayText: string,
	selection?: { // store as JSON so dont have to worry about serialization
		startLineNumber: number
		startColumn: number,
		endLineNumber: number
		endColumn: number,
	} | undefined
} | null
