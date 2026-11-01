/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { chat_userMessageContent, isABuiltinToolName } from '../common/prompt/prompts.js';
import { AnthropicReasoning, getErrorMessage, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { TokenUsage } from '../common/tokenUsage.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FeatureName, ModelSelection, ModelSelectionOptions } from '../common/zeroEgressSettingsTypes.js';
import { IZeroEgressSettingsService } from '../common/zeroEgressSettingsService.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
import { IToolsService } from './toolsService.js';
import { IChangeOwnersService, OwnershipConflictError } from './changeOwnersService.js';
import { UNOWNED } from '../common/changeOwners.js';
import { ICommandAllowListService } from './commandAllowListService.js';
import { restoreTargets } from '../common/reviewScope.js';
import { basename } from '../../../../base/common/resources.js';
import { IPendingFileOpsService } from './pendingFileOpsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ChatMessage, CheckpointEntry, CodespanLocationLink, StagingSelectionItem, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IMetricsService } from '../common/metricsService.js';
import { shorten } from '../../../../base/common/labels.js';
import { IZeroEgressModelService } from '../common/zeroEgressModelService.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { ZeroEgressFileSnapshot } from '../common/editCodeServiceTypes.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { CHAT_OPEN_TABS_STORAGE_KEY, THREAD_STORAGE_KEY } from '../common/storageKeys.js';
import { closeTab as closeTabOf, openTab, restoreTabs } from '../common/chatTabs.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { Compaction, COMPACT_SYSTEM_PROMPT, compactionAfterCut, compactionCut, compactionStillValid, compactionTranscript } from '../common/compaction.js';
import { timeout } from '../../../../base/common/async.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMCPService } from '../common/mcpService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { AGENT_WORKTREE_REMOVED_MESSAGE, agentRootOf, BackgroundAgentInfo, ToolRunContext } from '../common/backgroundAgentTypes.js';
import { resolveAgentPath } from '../common/agentPaths.js';
import { checkTerminalOwner } from '../common/terminalOwnership.js';
import { ITerminalToolService } from './terminalToolService.js';
import { RunPhase } from '../common/agentStatus.js';
import { SlotQueue } from '../common/slotQueue.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { AGENTS_MAX_CONCURRENT_DEFAULT, AGENTS_MAX_CONCURRENT_SETTING } from '../common/zeroEgressConfiguration.js';
import { clampConcurrency, parallelRequestsOf } from '../common/zeroEgressSettingsTypes.js';
import { refusalOf, ToolPolicy, toolPolicyOfMode } from '../common/toolPolicy.js';


// related to retrying when LLM message has error
const CHAT_RETRIES = 3
const RETRY_DELAY = 2500


const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) return null

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i]

		if (s.uri.fsPath !== newSelection.uri.fsPath) continue

		if (s.type === 'File' && newSelection.type === 'File') {
			return i
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			// if there's any collision return true
			const [oldStart, oldEnd] = s.range
			const [newStart, newEnd] = newSelection.range
			if (oldStart !== newStart || oldEnd !== newEnd) continue
			return i
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			return i
		}
	}
	return null
}


/*

Store a checkpoint of all "before" files on each x.
x's show up before user messages and LLM edit tool calls.

x     A          (edited A -> A')
(... user modified changes ...)
User message

x     A' B C     (edited A'->A'', B->B', C->C')
LLM Edit
x
LLM Edit
x
LLM Edit


INVARIANT:
A checkpoint appears before every LLM message, and before every user message (before user really means directly after LLM is done).
*/


type UserMessageType = ChatMessage & { role: 'user' }
type UserMessageState = UserMessageType['state']
const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
}

// a 'thread' means a chat message history

type WhenMounted = {
	textAreaRef: { current: HTMLTextAreaElement | null }; // the textarea that this thread has, gets set in SidebarChat
	scrollToBottom: () => void;
}



const COMPACT_TIMEOUT_MS = 180_000

export type ThreadType = {
	id: string; // store the id here too
	createdAt: string; // ISO string
	lastModified: string; // ISO string

	/** set by the user (rename); otherwise the title comes from the first message (threadTitleOf) */
	title?: string;

	messages: ChatMessage[];
	filesWithUserChanges: Set<string>;

	/** the earlier turns, summarized: the model sees the summary in place of messages[0..uptoIdx) */
	compaction?: Compaction;

	/** set when this thread runs as a background agent in its own git worktree */
	agent?: BackgroundAgentInfo;

	// this doesn't need to go in a state object, but feels right
	state: {
		currCheckpointIdx: number | null; // the latest checkpoint we're at (null if not at a particular checkpoint, like if the chat is streaming, or chat just finished and we haven't clicked on a checkpt)

		stagingSelections: StagingSelectionItem[];
		focusedMessageIdx: number | undefined; // index of the user message that is being edited (undefined if none)

		linksOfMessageIdx: { // eg. link = linksOfMessageIdx[4]['RangeFunction']
			[messageIdx: number]: {
				[codespanName: string]: CodespanLocationLink
			}
		}


		mountedInfo?: {
			whenMounted: Promise<WhenMounted>
			_whenMountedResolver: (res: WhenMounted) => void
			mountedIsResolvedRef: { current: boolean };
		}


	};
}

type ChatThreads = {
	[id: string]: undefined | ThreadType;
}


export type ThreadsState = {
	allThreads: ChatThreads;
	currentThreadId: string; // intended for internal use only
	/** the docked panel's tabs, left to right (persisted); background-agent threads never get one */
	openTabIds: string[];
}

// 'LLM' | 'tool' | 'awaiting_user' | 'idle' | 'waiting_for_model' | undefined (see RunPhase)
export type IsRunningType = RunPhase

export type ThreadStreamState = {
	[threadId: string]: undefined | {
		isRunning: undefined;
		error?: { message: string, fullError: Error | null, };
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	} | { // a tool is being run
		isRunning: 'tool';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo: {
			toolName: ToolName;
			toolParams: ToolCallParams<ToolName>;
			id: string;
			content: string;
			rawParams: RawToolParamsObj;
			mcpServerName: string | undefined;
		};
		interrupt: Promise<() => void>;
	} | {
		isRunning: 'awaiting_user';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | {
		isRunning: 'idle';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	} | { // queued for a slot in the shared model queue
		isRunning: 'waiting_for_model';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // leaves the queue
	}
}

const newThreadObject = () => {
	const now = new Date().toISOString()
	return {
		id: generateUuid(),
		createdAt: now,
		lastModified: now,
		messages: [],
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set()
	} satisfies ThreadType
}






export interface IChatThreadService {
	readonly _serviceBrand: undefined;

	readonly state: ThreadsState;
	readonly streamState: ThreadStreamState; // not persistent
	readonly slotQueue: SlotQueue; // one queue shared by every thread: model slots per provider, plus background-run slots

	onDidChangeCurrentThread: Event<void>;
	onDidChangeStreamState: Event<{ threadId: string }>

	getCurrentThread(): ThreadType;
	openNewThread(): void;
	switchToThread(threadId: string): void;

	// tabs and history
	/** an empty or blank title clears it, so the thread falls back to its first message */
	renameThread(threadId: string, title: string): void;
	/** closes the tab only: the thread stays in history and keeps its changes */
	closeTab(threadId: string): void;
	/** stops the thread first if it is running (its tool calls and model slot), then deletes it */
	deleteThread(threadId: string): Promise<void>;
	duplicateThread(threadId: string): void;

	// background agents (never the current thread)
	/** creates a background-agent thread with `messages` and sends `prompt` in it; returns its id */
	startBackgroundThread(agent: BackgroundAgentInfo, messages: ChatMessage[], prompt: string): string;
	/** replaces a background thread's agent info (persisted) */
	setBackgroundAgentInfo(threadId: string, agent: BackgroundAgentInfo): void;

	// exposed getters/setters
	// these all apply to current thread
	// an optional trailing `threadId` targets that thread instead (the Agents view shows threads that are never current)
	getCurrentMessageState: (messageIdx: number, threadId?: string) => UserMessageState
	setCurrentMessageState: (messageIdx: number, newState: Partial<UserMessageState>, threadId?: string) => void
	getCurrentThreadState: () => ThreadType['state']
	setCurrentThreadState: (newState: Partial<ThreadType['state']>, threadId?: string) => void

	// you can edit multiple messages - the one you're currently editing is "focused", and we add items to that one when you press cmd+L.
	getCurrentFocusedMessageIdx(threadId?: string): number | undefined;
	isCurrentlyFocusingMessage(threadId?: string): boolean;
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined, threadId?: string): void;

	popStagingSelections(numPops?: number): void;
	addNewStagingSelection(newSelection: StagingSelectionItem): void;

	dangerousSetState: (newState: ThreadsState) => void;
	resetState: () => void;

	// // current thread's staging selections
	// closeCurrentStagingSelectionsInMessage(opts: { messageIdx: number }): void;
	// closeCurrentStagingSelectionsInThread(): void;

	// codespan links (link to symbols in the markdown)
	getCodespanLink(opts: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined;
	addCodespanLink(opts: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }): void;
	generateCodespanLink(opts: { codespanStr: string, threadId: string }): Promise<CodespanLocationLink>;
	getRelativeStr(uri: URI): string | undefined

	// entry pts
	abortRunning(threadId: string): Promise<void>;
	dismissStreamError(threadId: string): void;

	/** summarize the earlier turns of a chat into one message the model sees in their place */
	compactThread(threadId: string): Promise<void>;
	/** true while a summary for this chat is being written (fires onDidChangeCurrentThread on change) */
	isCompacting(threadId: string): boolean;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, threadId }: { userMessage: string, threadId: string }): Promise<void>;

	// approve/reject
	approveLatestToolRequest(threadId: string): void;
	rejectLatestToolRequest(threadId: string): void;
	/**
	 * For a tool_request with a `conflict`: accepts or rejects the other chat's changes that block its path, gives the
	 * path to this chat, then runs the tool. To stop instead, use rejectLatestToolRequest.
	 */
	resolveConflictAndContinue(threadId: string, choice: 'accept' | 'reject'): Promise<void>;

	// jump to history
	jumpToCheckpointBeforeMessageIdx(opts: { threadId: string, messageIdx: number, jumpToUserModified: boolean }): void;

	focusCurrentChat: (threadId?: string) => Promise<void>
	blurCurrentChat: () => Promise<void>
}

export const IChatThreadService = createDecorator<IChatThreadService>('zeroEgressChatThreadService');
class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	readonly streamState: ThreadStreamState = {}
	readonly slotQueue: SlotQueue = this._register(new SlotQueue())
	state: ThreadsState // allThreads is persisted, currentThread is not

	// used in checkpointing
	// private readonly _userModifiedFilesToCheckInCheckpoints = new LRUCache<string, null>(50)



	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IZeroEgressModelService private readonly _zeroEgressModelService: IZeroEgressModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IZeroEgressSettingsService private readonly _settingsService: IZeroEgressSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IMCPService private readonly _mcpService: IMCPService,
		@ITerminalToolService private readonly _terminalToolService: ITerminalToolService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IChangeOwnersService private readonly _changeOwnersService: IChangeOwnersService,
		@ICommandAllowListService private readonly _commandAllowListService: ICommandAllowListService,
		@IPendingFileOpsService private readonly _pendingFileOpsService: IPendingFileOpsService,
	) {
		super()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string, openTabIds: [] } // default state

		const readThreads = this._readAllThreads() || {}

		const allThreads = readThreads
		const restored = this._readOpenTabs(allThreads)
		this.state = {
			allThreads: allThreads,
			currentThreadId: null as unknown as string, // set just below
			openTabIds: restored.tabs,
		}

		// always be in a thread: the chat that was current when the tabs were last stored, else a new one
		if (restored.current !== undefined) {
			this._setState({ currentThreadId: restored.current })
		} else {
			this.openNewThread()
		}


		// keep track of user-modified files
		// const disposablesOfModelId: { [modelId: string]: IDisposable[] } = {}
		// this._register(
		// 	this._modelService.onModelAdded(e => {
		// 		if (!(e.id in disposablesOfModelId)) disposablesOfModelId[e.id] = []
		// 		disposablesOfModelId[e.id].push(
		// 			e.onDidChangeContent(() => { this._userModifiedFilesToCheckInCheckpoints.set(e.uri.fsPath, null) })
		// 		)
		// 	})
		// )
		// this._register(this._modelService.onModelRemoved(e => {
		// 	if (!(e.id in disposablesOfModelId)) return
		// 	disposablesOfModelId[e.id].forEach(d => d.dispose())
		// }))

	}

	async focusCurrentChat(threadId: string = this.state.currentThreadId) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage(threadId)) {
			s?.textAreaRef.current?.focus()
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.blur()
		}
	}



	dangerousSetState = (newState: ThreadsState) => {
		this.state = newState
		this._onDidChangeCurrentThread.fire()
	}
	resetState = () => {
		this.state = { allThreads: {}, currentThreadId: null as unknown as string, openTabIds: [] } // see constructor
		this.openNewThread()
		this._onDidChangeCurrentThread.fire()
	}

	// !!! this is important for properly restoring URIs from storage
	// should probably re-use code from src/vs/base/common/marshalling.ts instead. but this is simple enough
	private _convertThreadDataFromStorage(threadsStr: string): ChatThreads {
		return JSON.parse(threadsStr, (key, value) => {
			if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
				return URI.from(value); // TODO URI.revive instead of this?
			}
			return value;
		});
	}

	private _readAllThreads(): ChatThreads | null {
		const threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!threadsStr) {
			return null
		}
		const threads = this._convertThreadDataFromStorage(threadsStr);

		return threads
	}

	private _storeAllThreads(threads: ChatThreads) {
		const serializedThreads = JSON.stringify(threads);
		this._storageService.store(
			THREAD_STORAGE_KEY,
			serializedThreads,
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
	}


	/** the stored tabs and current chat, minus threads that no longer exist and background agents (see restoreTabs) */
	private _readOpenTabs(threads: ChatThreads): { tabs: string[]; current: string | undefined } {
		let stored: unknown = undefined
		try {
			const str = this._storageService.get(CHAT_OPEN_TABS_STORAGE_KEY, StorageScope.APPLICATION)
			stored = str ? JSON.parse(str) : undefined
		} catch {
			stored = undefined
		}
		return restoreTabs(stored, id => !!threads[id], id => !!threads[id]?.agent)
	}

	private _storeOpenTabs(tabs: string[], current: string) {
		this._storageService.store(CHAT_OPEN_TABS_STORAGE_KEY, JSON.stringify({ tabs, current }), StorageScope.APPLICATION, StorageTarget.USER)
	}

	/** an existing empty docked thread, else a new one added to `threads` */
	private _emptyThreadIn(threads: ChatThreads): { threads: ChatThreads; id: string; created: boolean } {
		for (const threadId in threads) {
			if (threads[threadId] && threads[threadId]!.messages.length === 0 && !threads[threadId]!.agent) {
				return { threads, id: threadId, created: false }
			}
		}
		const newThread = newThreadObject()
		return { threads: { ...threads, [newThread.id]: newThread }, id: newThread.id, created: true }
	}

	/** the tabs with `threadId` added (the cap drops the oldest idle tab); background agents get none */
	private _tabsWith(threadId: string, threads: ChatThreads = this.state.allThreads): string[] {
		if (!threads[threadId] || threads[threadId]?.agent) return this.state.openTabIds
		return openTab(this.state.openTabIds, threadId, id => !!this.streamState[id]?.isRunning)
	}

	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		const newState = {
			...this.state,
			...state
		}

		const tabsChanged = newState.openTabIds !== this.state.openTabIds || newState.currentThreadId !== this.state.currentThreadId
		this.state = newState
		if (tabsChanged && newState.currentThreadId) this._storeOpenTabs(newState.openTabIds, newState.currentThreadId)

		this._onDidChangeCurrentThread.fire()


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId
		const streamState = this.streamState[threadId]
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages
			const lastMessage = messages && messages[messages.length - 1]
			// if awaiting user but stream state doesn't indicate it (happens if restart ZeroEgress)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request')
				this._setStreamState(threadId, { isRunning: 'awaiting_user', })

			// if running now but stream state doesn't indicate it (happens if restart ZeroEgress), cancel that last tool
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {

				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: lastMessage.content, id: lastMessage.id, rawParams: lastMessage.rawParams, result: null, name: lastMessage.name, params: lastMessage.params, mcpServerName: lastMessage.mcpServerName })
			}

		}


		// if we did not just set the state to true, set mount info
		if (doNotRefreshMountInfo) return

		let whenMountedResolver: (w: WhenMounted) => void
		const whenMountedPromise = new Promise<WhenMounted>((res) => whenMountedResolver = res)

		this._setThreadState(threadId, {
			mountedInfo: {
				whenMounted: whenMountedPromise,
				mountedIsResolvedRef: { current: false },
				_whenMountedResolver: (w: WhenMounted) => {
					whenMountedResolver(w)
					const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo
					if (mountInfo) mountInfo.mountedIsResolvedRef.current = true
				},
			}
		}, true) // do not trigger an update



	}


	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		this.streamState[threadId] = state
		this._onDidChangeStreamState.fire({ threadId })
	}


	// ---------- streaming ----------



	private _currentModelSelectionProps = () => {
		// these settings should not change throughout the loop (eg some providers break if you change their thinking mode and they're using tools)
		const featureName: FeatureName = 'Chat'
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
		return { modelSelection, modelSelectionOptions }
	}



	private _swapOutLatestStreamingToolWithResult = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) return false
		const lastMsg = messages[messages.length - 1]
		if (!lastMsg) return false

		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			this._editMessageInThread(threadId, messages.length - 1, tool)
			return true
		}
		return false
	}
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const swapped = this._swapOutLatestStreamingToolWithResult(threadId, tool)
		if (swapped) return
		this._addMessageToThread(threadId, tool)
	}

	approveLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) return // should never happen
		if (this._refuseIfWorktreeRemoved(threadId)) return

		const callThisToolFirst: ToolMessage<ToolName> = lastMsg

		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, ...this._currentModelSelectionProps() })
			, threadId
		)
	}
	async resolveConflictAndContinue(threadId: string, choice: 'accept' | 'reject') {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg?.role === 'tool' && lastMsg.type === 'tool_request' && lastMsg.conflict)) return
		const { uri } = lastMsg.conflict
		// a chat deleted since the card was shown no longer owns anything: its changes are unowned now (the card already
		// says "made outside this chat"), so resolve them without another click
		const ownerThreadId = this.state.allThreads[lastMsg.conflict.ownerThreadId] ? lastMsg.conflict.ownerThreadId : UNOWNED

		// only the named chat's changes that block this path: its files at or under it, and its folder ops above it.
		// If resolving them would also touch a third chat's changes, the card names that chat instead and nothing is resolved
		const blocking = this._changeOwnersService.changesBlocking(uri, threadId, ownerThreadId)
		if (blocking && blocking.owner !== ownerThreadId) {
			this._updateLatestTool(threadId, { ...lastMsg, conflict: { uri, ownerThreadId: blocking.owner } })
			return
		}
		// the blocker can be UNOWNED (changes no chat owns): those are resolved the same way
		if (blocking) {
			try {
				for (const owned of blocking.uris) {
					await this._editCodeService.acceptOrRejectAllDiffAreas({ uri: owned, behavior: choice, removeCtrlKs: false })
					await this._pendingFileOpsService.resolveAll(choice, owned)
				}
				for (const id of blocking.opIds) {
					await this._pendingFileOpsService.resolve(id, choice)
				}
			} catch (e) {
				// the card stays (nothing continues): say why instead of leaving it to the console
				this._notificationService.error(`Could not ${choice} the other changes: ${getErrorMessage(e)}`)
				return
			}
		}
		// the thread may have moved on (deleted, or stopped) while the review ran
		const messages = this.state.allThreads[threadId]?.messages
		const latest = messages?.[messages.length - 1]
		if (!(latest?.role === 'tool' && latest.type === 'tool_request' && latest.id === lastMsg.id)) return

		// if something still blocks it (another chat's write in flight, or a second chat), the tool call shows the card again
		if (!this._changeOwnersService.conflictFor(uri, threadId)) this._changeOwnersService.transfer(uri, threadId)
		this.approveLatestToolRequest(threadId)
	}

	rejectLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]

		let params: ToolCallParams<ToolName>
		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			params = lastMsg.params
		}
		else return

		const { name, id, rawParams, mcpServerName } = lastMsg

		const errorMessage = this.toolErrMsgs.rejected
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName })
		this._setStreamState(threadId, undefined)
	}

	private _computeMCPServerOfToolName = (toolName: string) => {
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName
	}

	async abortRunning(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
			this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
			if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })
		}
		// add tool that's running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, mcpServerName } = this.streamState[threadId].toolInfo
			const content = content_ || this.toolErrMsgs.interrupted
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, type: 'rejected', result: null, mcpServerName })
		}
		// reject the tool for the user if relevant
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId)
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}
		else if (this.streamState[threadId]?.isRunning === 'waiting_for_model') {
			// nothing was said yet; the interrupt below leaves the queue
		}

		this._addUserCheckpoint({ threadId })

		// interrupt any effects
		const interrupt = await this.streamState[threadId]?.interrupt
		if (typeof interrupt === 'function')
			interrupt()


		this._setStreamState(threadId, undefined)
	}



	private readonly toolErrMsgs = {
		rejected: 'Tool call was rejected by the user.',
		interrupted: 'Tool call was interrupted by the user.',
		errWhenStringifying: (error: any) => `Tool call succeeded, but there was an error stringifying the output.\n${getErrorMessage(error)}`
	}


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}


	/** whose files this thread's tools work on */
	private _toolContextOf(threadId: string): ToolRunContext {
		const agent = this.state.allThreads[threadId]?.agent
		return agent ? { kind: 'background', agent } : { kind: 'docked', threadId }
	}

	/** maps every path param into the agent's root, or throws (`Path is outside this agent's worktree: ...`) */
	private _confineToolParams(toolName: ToolName, params: ToolCallParams<ToolName>, agent: BackgroundAgentInfo): ToolCallParams<ToolName> {
		if (!agent.worktreePath) throw new Error(AGENT_WORKTREE_REMOVED_MESSAGE)
		const agentRoot = agentRootOf(agent)
		const roots = { agentRoot, userRoot: agent.userRoot }
		const confined: Record<string, unknown> = { ...params }
		for (const [key, value] of Object.entries(params)) {
			if (!URI.isUri(value)) continue
			if (value.scheme !== 'file') throw new Error(`Path is outside this agent's worktree: ${value.toString()}`)
			confined[key] = URI.file(resolveAgentPath(value.fsPath, roots))
		}
		if (toolName === 'run_command' || toolName === 'open_persistent_terminal') {
			const cwd = (params as BuiltinToolCallParams['run_command']).cwd
			confined.cwd = cwd === null ? agentRoot : resolveAgentPath(cwd, roots)
		}
		return confined as ToolCallParams<ToolName>
	}


	/** run_command / run_persistent_command only: the command is on this workspace's allow-list. */
	private _isAllowListedCommand(toolName: ToolName, params: ToolCallParams<ToolName>): boolean {
		if (toolName !== 'run_command' && toolName !== 'run_persistent_command') { return false }
		return this._commandAllowListService.isAllowed((params as { command: string }).command)
	}

	/** the path a docked file tool writes, which another chat's unreviewed changes can block */
	private _writeTargetOf(toolName: ToolName, params: ToolCallParams<ToolName>): URI | undefined {
		if (toolName === 'edit_file' || toolName === 'rewrite_file' || toolName === 'create_file_or_folder' || toolName === 'delete_file_or_folder') {
			return (params as BuiltinToolCallParams['edit_file']).uri
		}
		return undefined
	}

	// returns true when the tool call is waiting for user approval
	private _runToolCall = async (
		threadId: string,
		toolName: ToolName,
		toolId: string,
		mcpServerName: string | undefined,
		toolPolicy: ToolPolicy | null,
		opts: { preapproved: true, unvalidatedToolParams: RawToolParamsObj, validatedParams: ToolCallParams<ToolName> } | { preapproved: false, unvalidatedToolParams: RawToolParamsObj },
	): Promise<{ awaitingUserApproval?: boolean, interrupted?: boolean }> => {

		// a deleted thread (e.g. a background agent deleted mid-run) runs nothing, and never falls back to the docked context
		if (!this.state.allThreads[threadId]) return { interrupted: true }

		// compute these below
		let toolParams: ToolCallParams<ToolName>
		let toolResult: ToolResult<ToolName>
		let toolResultStr: string

		// Check if it's a built-in tool
		const isBuiltInTool = isABuiltinToolName(toolName)

		// the run's policy decides which tools may run, whatever the model asked for (also for a just-approved tool)
		const refusal = refusalOf(toolPolicy, toolName, !isBuiltInTool)
		if (refusal) {
			// replaces the pending request when the tool was just approved, else adds a message
			this._updateLatestTool(threadId, { role: 'tool', type: 'invalid_params', refused: true, result: null, name: toolName, content: refusal, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}
		const toolCtx = this._toolContextOf(threadId)


		if (!opts.preapproved) { // skip this if pre-approved
			// 1. validate tool params
			try {
				if (isBuiltInTool) {
					const params = this._toolsService.validateParams[toolName](opts.unvalidatedToolParams)
					toolParams = params
				}
				else {
					toolParams = opts.unvalidatedToolParams
				}
				// background agents: confine every path to the agent's worktree (MCP tools have no paths we know of)
				if (toolCtx.kind === 'background') {
					if (!toolCtx.agent.worktreePath) { throw new Error(AGENT_WORKTREE_REMOVED_MESSAGE) }
					if (isBuiltInTool) { toolParams = this._confineToolParams(toolName, toolParams, toolCtx.agent) }
				}
				// persistent terminals are owned per thread: background agents use only their own, docked only the unowned ones
				if (toolName === 'run_persistent_command' || toolName === 'kill_persistent_terminal') {
					const { persistentTerminalId } = toolParams as BuiltinToolCallParams['kill_persistent_terminal']
					checkTerminalOwner(persistentTerminalId, id => this._terminalToolService.ownerOfPersistentTerminal(id), toolCtx.kind === 'background' ? toolCtx.agent.agentId : undefined)
				}
			}
			catch (error) {
				const errorMessage = getErrorMessage(error)
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: errorMessage, id: toolId, mcpServerName })
				return {}
			}
			// once validated, add checkpoint for edit
			if (toolName === 'edit_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['edit_file']).uri }) }
			if (toolName === 'rewrite_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['rewrite_file']).uri }) }

			// 2. if tool requires approval, break from the loop, awaiting approval

			// another docked chat has unreviewed changes there: ask with the conflict card, even when edits are auto-approved
			const conflictUri = toolCtx.kind === 'docked' ? this._writeTargetOf(toolName, toolParams) : undefined
			const conflict = conflictUri && this._changeOwnersService.changesBlocking(conflictUri, threadId)
			if (conflictUri && conflict) {
				this._addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName, conflict: { uri: conflictUri, ownerThreadId: conflict.owner } })
				return { awaitingUserApproval: true }
			}

			const approvalType = isBuiltInTool ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools'
			if (approvalType) {
				// background agents never ask for edits, creates and deletes: they land in the worktree and are reviewed later
				const autoApprove = (toolCtx.kind === 'background' && approvalType === 'edits') || this._settingsService.state.globalSettings.autoApprove[approvalType]
					|| (approvalType === 'terminal' && this._settingsService.state.globalSettings.useCommandAllowList && this._isAllowListedCommand(toolName, toolParams))
				// add a tool_request because we use it for UI if a tool is loading (this should be improved in the future)
				this._addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
				if (!autoApprove) {
					return { awaitingUserApproval: true }
				}
			}
		}
		else {
			toolParams = opts.validatedParams
		}






		// 3. call the tool
		// this._setStreamState(threadId, { isRunning: 'tool' }, 'merge')
		const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName } as const
		this._updateLatestTool(threadId, runningTool)


		let interrupted = false
		let resolveInterruptor: (r: () => void) => void = () => { }
		const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res })
		try {

			// set stream state
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, mcpServerName } })

			// the worktree can be removed while a tool waits for approval
			if (toolCtx.kind === 'background' && !toolCtx.agent.worktreePath) { throw new Error(AGENT_WORKTREE_REMOVED_MESSAGE) }

			if (isBuiltInTool) {
				const { result, interruptTool } = await this._toolsService.callTool[toolName](toolParams as any, toolCtx)
				const interruptor = () => { interrupted = true; interruptTool?.() }
				resolveInterruptor(interruptor)

				toolResult = await result
			}
			else {
				const mcpTools = this._mcpService.getMCPTools()
				const mcpTool = mcpTools?.find(t => t.name === toolName)
				if (!mcpTool) { throw new Error(`MCP tool ${toolName} not found`) }

				resolveInterruptor(() => { })

				toolResult = (await this._mcpService.callMCPTool({
					serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
					toolName: toolName,
					params: toolParams
				})).result
			}

			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here
		}
		catch (error) {
			resolveInterruptor(() => { }) // resolve for the sake of it
			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here

			// race guard: another chat claimed the path after the check above (or while this call awaited approval)
			const conflictUri = error instanceof OwnershipConflictError && toolCtx.kind === 'docked' ? this._writeTargetOf(toolName, toolParams) : undefined
			if (conflictUri && error instanceof OwnershipConflictError) {
				this._updateLatestTool(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName, conflict: { uri: conflictUri, ownerThreadId: this._changeOwnersService.changesBlocking(conflictUri, threadId)?.owner ?? error.owner } })
				return { awaitingUserApproval: true }
			}

			const errorMessage = getErrorMessage(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}

		// 4. stringify the result to give to the LLM
		try {
			if (isBuiltInTool) {
				toolResultStr = this._toolsService.stringOfResult[toolName](toolParams as any, toolResult as any, toolCtx)
			}
			// For MCP tools, handle the result based on its type
			else {
				toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall)
			}
		} catch (error) {
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}

		// 5. add to history and keep going
		this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
		return {}
	};




	private _maxConcurrentAgents(): number {
		return clampConcurrency(this._configurationService.getValue<number>(AGENTS_MAX_CONCURRENT_SETTING), AGENTS_MAX_CONCURRENT_DEFAULT)
	}

	/**
	 * Queues for a slot while the thread shows 'waiting_for_model'. Returns undefined if the user interrupted the wait
	 * (abortRunning then resets the stream state). `onInterrupt` also runs if the interrupt lands just after the slot was granted.
	 */
	private async _waitForSlot(threadId: string, key: string, limit: number, priority: boolean, onInterrupt: () => void): Promise<IDisposable | undefined> {
		const cts = new CancellationTokenSource()
		let interrupted = false
		this._setStreamState(threadId, { isRunning: 'waiting_for_model', interrupt: Promise.resolve(() => { interrupted = true; cts.cancel(); onInterrupt() }) })
		try {
			const slot = await this.slotQueue.acquire(key, limit, { priority, token: cts.token })
			if (interrupted) { slot.dispose(); return undefined }
			return slot
		}
		catch (e) {
			if (isCancellationError(e)) return undefined
			throw e
		}
		finally {
			cts.dispose()
		}
	}

	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
	}: {
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined,

		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' }
	}) {


		if (!this.state.allThreads[threadId]) return // deleted

		let interruptedWhenIdle = false
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true })
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		// above just defines helpers, below starts the actual function
		// should not change as we loop even if user changes it, so it goes here. Background agents always run in agent mode.
		const backgroundAgent = this.state.allThreads[threadId]?.agent
		const chatMode = backgroundAgent ? 'agent' : this._settingsService.state.globalSettings.chatMode
		const toolPolicy = toolPolicyOfMode(chatMode)
		const agentRoot = backgroundAgent ? { folder: agentRootOf(backgroundAgent), depsMayBeMissing: !backgroundAgent.setup?.command, agentId: backgroundAgent.agentId } : undefined
		const { overridesOfModel } = this._settingsService.state

		// a background run holds one of the 'agents' slots from start to end; the docked thread never takes one
		let agentSlot: IDisposable | undefined
		if (backgroundAgent) {
			agentSlot = await this._waitForSlot(threadId, 'agents', this._maxConcurrentAgents(), false, () => { interruptedWhenIdle = true })
			if (!agentSlot || interruptedWhenIdle) { agentSlot?.dispose(); return }
		}

		try {

			let nMessagesSent = 0
			let shouldSendAnotherMessage = true
			let isRunningWhenEnd: IsRunningType = undefined

			// before enter loop, call tool
			if (callThisToolFirst) {
				const { interrupted, awaitingUserApproval } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, toolPolicy, { preapproved: true, unvalidatedToolParams: callThisToolFirst.rawParams, validatedParams: callThisToolFirst.params })
				if (interrupted) {
					this._setStreamState(threadId, undefined)
					this._addUserCheckpoint({ threadId })

				}
				// the approved write hit another chat's changes (the race guard): it waits on the conflict card again
				if (awaitingUserApproval) {
					this._setStreamState(threadId, { isRunning: 'awaiting_user' })
					return
				}
			}
			this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })  // just decorative, for clarity


			// tool use loop
			while (shouldSendAnotherMessage) {
				// a thread deleted mid-run (e.g. a background agent) stops here
				if (!this.state.allThreads[threadId]) { this._setStreamState(threadId, undefined); return }

				// false by default each iteration
				shouldSendAnotherMessage = false
				isRunningWhenEnd = undefined
				nMessagesSent += 1

				this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })

				const chatMessages = this.state.allThreads[threadId]?.messages ?? []
				const { messages, separateSystemMessage } = await this._convertToLLMMessagesService.prepareLLMChatMessages({
					chatMessages,
					modelSelection,
					chatMode,
					toolPolicy,
					agentRoot,
					compaction: this.state.allThreads[threadId]?.compaction,
				})

				if (interruptedWhenIdle) {
					this._setStreamState(threadId, undefined)
					return
				}

				let shouldRetryLLM = true
				let nAttempts = 0
				while (shouldRetryLLM) {
					shouldRetryLLM = false
					nAttempts += 1

					type ResTypes =
						| { type: 'llmDone', toolCall?: RawToolCallObj, info: { fullText: string, fullReasoning: string, anthropicReasoning: AnthropicReasoning[] | null, usage?: TokenUsage } }
						| { type: 'llmError', error?: { message: string; fullError: Error | null; } }
						| { type: 'llmAborted' }

					let resMessageIsDonePromise: (res: ResTypes) => void // resolves when user approves this tool use (or if tool doesn't require approval)
					const messageIsDonePromise = new Promise<ResTypes>((res, rej) => { resMessageIsDonePromise = res })

					// wait for a slot on this provider (shared with every other thread); the docked thread goes first
					let llmCancelToken: string | null = null
					let modelSlot: IDisposable | undefined
					if (modelSelection) {
						const limit = parallelRequestsOf(this._settingsService.state.settingsOfProvider[modelSelection.providerName])
						modelSlot = await this._waitForSlot(threadId, `model:${modelSelection.providerName}`, limit, !backgroundAgent, () => {
							interruptedWhenIdle = true
							if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) // interrupted just as the request started
						})
						if (!modelSlot || interruptedWhenIdle) { modelSlot?.dispose(); return }
					}
					const releaseModelSlot = () => modelSlot?.dispose() // idempotent

					// how long the model reasoned, shown as "Thought for <n>s"
					let reasoningStartedAt: number | undefined = undefined
					let reasoningEndedAt: number | undefined = undefined
					try {
						llmCancelToken = this._llmMessageService.sendLLMMessage({
							messagesType: 'chatMessages',
							chatMode,
							toolPolicy,
							messages: messages,
							modelSelection,
							modelSelectionOptions,
							overridesOfModel,
							logging: { loggingName: `Chat - ${chatMode}`, loggingExtras: { threadId, nMessagesSent, chatMode } },
							separateSystemMessage: separateSystemMessage,
							onText: ({ fullText, fullReasoning, toolCall }) => {
								if (fullReasoning && reasoningStartedAt === undefined) reasoningStartedAt = Date.now()
								if ((fullText || toolCall) && reasoningStartedAt !== undefined && reasoningEndedAt === undefined) reasoningEndedAt = Date.now()
								this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallSoFar: toolCall ?? null }, interrupt: Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) }) })
							},
							onFinalMessage: async ({ fullText, fullReasoning, toolCall, anthropicReasoning, usage }) => {
								releaseModelSlot()
								resMessageIsDonePromise({ type: 'llmDone', toolCall, info: { fullText, fullReasoning, anthropicReasoning, usage } }) // resolve with tool calls
							},
							onError: async (error) => {
								releaseModelSlot()
								resMessageIsDonePromise({ type: 'llmError', error: error })
							},
							onAbort: () => {
								releaseModelSlot()
								// stop the loop to free up the promise, but don't modify state (already handled by whatever stopped it)
								resMessageIsDonePromise({ type: 'llmAborted' })
								this._metricsService.capture('Agent loop done (Aborted)', { nMessagesSent, chatMode })
							},
						})
					} catch (e) { releaseModelSlot(); throw e }

					// mark as streaming
					if (!llmCancelToken) {
						releaseModelSlot()
						this._setStreamState(threadId, { isRunning: undefined, error: { message: 'There was an unexpected error when sending your chat message.', fullError: null } })
						break
					}

					this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) }) })
					const llmRes = await messageIsDonePromise // wait for message to complete
					releaseModelSlot() // already released by the callback that resolved it; kept for safety

					// if something else started running in the meantime
					if (this.streamState[threadId]?.isRunning !== 'LLM') {
						// console.log('Chat thread interrupted by a newer chat thread', this.streamState[threadId]?.isRunning)
						return
					}

					// llm res aborted
					if (llmRes.type === 'llmAborted') {
						this._setStreamState(threadId, undefined)
						return
					}
					// llm res error
					else if (llmRes.type === 'llmError') {
						// error, should retry
						if (nAttempts < CHAT_RETRIES) {
							shouldRetryLLM = true
							this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
							await timeout(RETRY_DELAY)
							if (interruptedWhenIdle) {
								this._setStreamState(threadId, undefined)
								return
							}
							else
								continue // retry
						}
						// error, but too many attempts
						else {
							const { error } = llmRes
							const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
							this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
							if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })

							this._setStreamState(threadId, { isRunning: undefined, error })
							this._addUserCheckpoint({ threadId })
							return
						}
					}

					// llm res success
					const { toolCall, info } = llmRes

					const reasoningMs = reasoningStartedAt !== undefined && info.fullReasoning ? (reasoningEndedAt ?? Date.now()) - reasoningStartedAt : undefined
					this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, anthropicReasoning: info.anthropicReasoning, reasoningMs, usage: info.usage })

					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative for clarity

					// call tool if there is one
					if (toolCall) {
						const mcpTools = this._mcpService.getMCPTools()
						const mcpTool = mcpTools?.find(t => t.name === toolCall.name)

						const { awaitingUserApproval, interrupted } = await this._runToolCall(threadId, toolCall.name, toolCall.id, mcpTool?.mcpServerName, toolPolicy, { preapproved: false, unvalidatedToolParams: toolCall.rawParams })
						if (interrupted) {
							this._setStreamState(threadId, undefined)
							return
						}
						if (awaitingUserApproval) { isRunningWhenEnd = 'awaiting_user' }
						else { shouldSendAnotherMessage = true }

						this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative, for clarity
					}

				} // end while (attempts)
			} // end while (send message)

			// if awaiting user approval, keep isRunning true, else end isRunning
			this._setStreamState(threadId, { isRunning: isRunningWhenEnd })

			// add checkpoint before the next user message
			if (!isRunningWhenEnd) this._addUserCheckpoint({ threadId })

			// capture number of messages sent
			this._metricsService.capture('Agent loop done', { nMessagesSent, chatMode })
		} finally {
			agentSlot?.dispose() // the loop exited for any reason
		}
	}


	private _addCheckpoint(threadId: string, checkpoint: CheckpointEntry) {
		this._addMessageToThread(threadId, checkpoint)
		// // update latest checkpoint idx to the one we just added
		// const newThread = this.state.allThreads[threadId]
		// if (!newThread) return // should never happen
		// const currCheckpointIdx = newThread.messages.length - 1
		// this._setThreadState(threadId, { currCheckpointIdx: currCheckpointIdx })
	}



	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages.slice(0, messageIdx),
					newMessage,
					...oldThread.messages.slice(messageIdx + 1, Infinity),
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}


	private _getCheckpointInfo = (checkpointMessage: ChatMessage & { role: 'checkpoint' }, fsPath: string, opts: { includeUserModifiedChanges: boolean }) => {
		const zeroEgressFileSnapshot = checkpointMessage.zeroEgressFileSnapshotOfURI ? checkpointMessage.zeroEgressFileSnapshotOfURI[fsPath] ?? null : null
		if (!opts.includeUserModifiedChanges) { return { zeroEgressFileSnapshot, } }

		const userModifiedZeroEgressFileSnapshot = fsPath in checkpointMessage.userModifications.zeroEgressFileSnapshotOfURI ? checkpointMessage.userModifications.zeroEgressFileSnapshotOfURI[fsPath] ?? null : null
		return { zeroEgressFileSnapshot: userModifiedZeroEgressFileSnapshot ?? zeroEgressFileSnapshot, }
	}

	private _computeNewCheckpointInfo({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const lastCheckpointIdx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint') ?? -1
		if (lastCheckpointIdx === -1) return

		const zeroEgressFileSnapshotOfURI: { [fsPath: string]: ZeroEgressFileSnapshot | undefined } = {}

		// add a change for all the URIs in the checkpoint history
		const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: 0, hiIdx: lastCheckpointIdx, }) ?? {}
		for (const fsPath in lastIdxOfURI ?? {}) {
			const { model } = this._zeroEgressModelService.getModelFromFsPath(fsPath)
			if (!model) continue
			const checkpoint2 = thread.messages[lastIdxOfURI[fsPath]] || null
			if (!checkpoint2) continue
			if (checkpoint2.role !== 'checkpoint') continue
			const res = this._getCheckpointInfo(checkpoint2, fsPath, { includeUserModifiedChanges: false })
			if (!res) continue
			const { zeroEgressFileSnapshot: oldZeroEgressFileSnapshot } = res

			// if there was any change to the str or diffAreaSnapshot, update. rough approximation of equality, oldDiffAreasSnapshot === diffAreasSnapshot is not perfect
			const zeroEgressFileSnapshot = this._editCodeService.getZeroEgressFileSnapshot(URI.file(fsPath))
			if (oldZeroEgressFileSnapshot === zeroEgressFileSnapshot) continue
			zeroEgressFileSnapshotOfURI[fsPath] = zeroEgressFileSnapshot
		}

		// // add a change for all user-edited files (that aren't in the history)
		// for (const fsPath of this._userModifiedFilesToCheckInCheckpoints.keys()) {
		// 	if (fsPath in lastIdxOfURI) continue // if already visisted, don't visit again
		// 	const { model } = this._zeroEgressModelService.getModelFromFsPath(fsPath)
		// 	if (!model) continue
		// 	currStrOfFsPath[fsPath] = model.getValue(EndOfLinePreference.LF)
		// }

		return { zeroEgressFileSnapshotOfURI }
	}


	private _addUserCheckpoint({ threadId }: { threadId: string }) {
		if (this.state.allThreads[threadId]?.agent) return // background agents are reviewed per hunk, not with checkpoints
		const { zeroEgressFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'user_edit',
			zeroEgressFileSnapshotOfURI: zeroEgressFileSnapshotOfURI ?? {},
			userModifications: { zeroEgressFileSnapshotOfURI: {}, },
		})
	}
	// call this right after LLM edits a file
	private _addToolEditCheckpoint({ threadId, uri, }: { threadId: string, uri: URI }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (thread.agent) return // background agents are reviewed per hunk, not with checkpoints
		const { model } = this._zeroEgressModelService.getModel(uri)
		if (!model) return // should never happen
		const diffAreasSnapshot = this._editCodeService.getZeroEgressFileSnapshot(uri)
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'tool_edit',
			zeroEgressFileSnapshotOfURI: { [uri.fsPath]: diffAreasSnapshot },
			userModifications: { zeroEgressFileSnapshotOfURI: {} },
		})
	}


	private _getCheckpointBeforeMessage = ({ threadId, messageIdx }: { threadId: string, messageIdx: number }): [CheckpointEntry, number] | undefined => {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined
		for (let i = messageIdx; i >= 0; i--) {
			const message = thread.messages[i]
			if (message.role === 'checkpoint') {
				return [message, i]
			}
		}
		return undefined
	}

	private _getCheckpointsBetween({ threadId, loIdx, hiIdx }: { threadId: string, loIdx: number, hiIdx: number }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return { lastIdxOfURI: {} } // should never happen
		const lastIdxOfURI: { [fsPath: string]: number } = {}
		for (let i = loIdx; i <= hiIdx; i += 1) {
			const message = thread.messages[i]
			if (message?.role !== 'checkpoint') continue
			for (const fsPath in message.zeroEgressFileSnapshotOfURI) { // do not include userModified.beforeStrOfURI here, jumping should not include those changes
				lastIdxOfURI[fsPath] = i
			}
		}
		return { lastIdxOfURI }
	}

	private _readCurrentCheckpoint(threadId: string): [CheckpointEntry, number] | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const { currCheckpointIdx } = thread.state
		if (currCheckpointIdx === null) return

		const checkpoint = thread.messages[currCheckpointIdx]
		if (!checkpoint) return
		if (checkpoint.role !== 'checkpoint') return
		return [checkpoint, currCheckpointIdx]
	}
	private _addUserModificationsToCurrCheckpoint({ threadId }: { threadId: string }) {
		const { zeroEgressFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		const res = this._readCurrentCheckpoint(threadId)
		if (!res) return
		const [checkpoint, checkpointIdx] = res
		this._editMessageInThread(threadId, checkpointIdx, {
			...checkpoint,
			userModifications: { zeroEgressFileSnapshotOfURI: zeroEgressFileSnapshotOfURI ?? {}, },
		})
	}


	private _makeUsStandOnCheckpoint({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (thread.state.currCheckpointIdx === null) {
			const lastMsg = thread.messages[thread.messages.length - 1]
			if (lastMsg?.role !== 'checkpoint')
				this._addUserCheckpoint({ threadId })
			this._setThreadState(threadId, { currCheckpointIdx: thread.messages.length - 1 })
		}
	}

	jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified }: { threadId: string, messageIdx: number, jumpToUserModified: boolean }) {

		// if null, add a new temp checkpoint so user can jump forward again
		this._makeUsStandOnCheckpoint({ threadId })

		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (this.streamState[threadId]?.isRunning) return

		const c = this._getCheckpointBeforeMessage({ threadId, messageIdx })
		if (c === undefined) return // should never happen

		const fromIdx = thread.state.currCheckpointIdx
		if (fromIdx === null) return // should never happen

		const [_, toIdx] = c
		if (toIdx === fromIdx) return

		// console.log(`going from ${fromIdx} to ${toIdx}`)

		// update the user's checkpoint
		this._addUserModificationsToCurrCheckpoint({ threadId })

		// never overwrite unreviewed changes that are not this chat's (another chat's, or unowned): those files keep their contents (one notification below)
		const skippedPaths: string[] = []
		const restoreFilter = (fsPaths: string[]) => {
			const { restore, skipped } = restoreTargets(
				fsPaths,
				p => this._changeOwnersService.ownerOf(URI.file(p)),
				p => this._changeOwnersService.hasPending(URI.file(p)),
				threadId,
			)
			skippedPaths.push(...skipped)
			return restore
		}

		/*
if undoing

A,B,C are all files.
x means a checkpoint where the file changed.

A B C D E F G H I
  x x x x x   x           <-- you can't always go up to find the "before" version; sometimes you need to go down
  | | | | |   | x
--x-|-|-|-x---x-|-----     <-- to
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-------     <-- from
	  x

We need to revert anything that happened between to+1 and from.
**We do this by finding the last x from 0...`to` for each file and applying those contents.**
We only need to do it for files that were edited since `to`, ie files between to+1...from.
*/
		if (toIdx < fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: toIdx + 1, hiIdx: fromIdx })

			const idxes = function* () {
				for (let k = toIdx; k >= 0; k -= 1) { // first go up
					yield k
				}
				for (let k = toIdx + 1; k < thread.messages.length; k += 1) { // then go down
					yield k
				}
			}

			for (const fsPath of restoreFilter(Object.keys(lastIdxOfURI))) {
				// find the first instance of this file starting at toIdx (go up to latest file; if there is none, go down)
				for (const k of idxes()) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { zeroEgressFileSnapshot } = res
					if (!zeroEgressFileSnapshot) continue
					this._editCodeService.restoreZeroEgressFileSnapshot(URI.file(fsPath), zeroEgressFileSnapshot)
					break
				}
			}
		}

		/*
if redoing

A B C D E F G H I J
  x x x x x   x     x
  | | | | |   | x x x
--x-|-|-|-x---x-|-|---     <-- from
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-----|---     <-- to
	  x           x


We need to apply latest change for anything that happened between from+1 and to.
We only need to do it for files that were edited since `from`, ie files between from+1...to.
*/
		if (toIdx > fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: fromIdx + 1, hiIdx: toIdx })
			for (const fsPath of restoreFilter(Object.keys(lastIdxOfURI))) {
				// apply lowest down content for each uri
				for (let k = toIdx; k >= fromIdx + 1; k -= 1) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { zeroEgressFileSnapshot } = res
					if (!zeroEgressFileSnapshot) continue
					this._editCodeService.restoreZeroEgressFileSnapshot(URI.file(fsPath), zeroEgressFileSnapshot)
					break
				}
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: toIdx })
		// the messages after the checkpoint are dropped on the next send; a summary reaching past it goes now
		const restored = this.state.allThreads[threadId]
		if (restored?.compaction && !compactionAfterCut(restored.compaction, toIdx + 1)) {
			const { compaction: _gone, ...rest } = restored
			const newThreads = { ...this.state.allThreads, [threadId]: rest }
			this._storeAllThreads(newThreads)
			this._setState({ allThreads: newThreads })
		}

		if (skippedPaths.length) {
			this._notificationService.notify({
				severity: Severity.Warning,
				message: `Restore skipped ${skippedPaths.length} file(s) with unreviewed changes from other chats: ${skippedPaths.map(p => basename(URI.file(p))).join(', ')}.`,
			})
		}
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId]
			if (!thread) return
			if (thread.agent) return // background agents report their status in the Agents view
			const userMsg = findLast(thread.messages, m => m.role === 'user')
			if (!userMsg) return
			if (userMsg.role !== 'user') return
			const messageContent = truncate(userMsg.displayContent, 50, '...')

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: error ? `Error: ${error} ` : `A new Chat result is ready.`,
				source: messageContent,
				sticky: true,
				actions: {
					primary: [{
						id: 'zeroEgress.goToChat',
						enabled: true,
						label: `Jump to Chat`,
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId)
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom()
							})
						}
					}]
				},
			})
		}

		p.then(() => {
			if (threadId !== this.state.currentThreadId) notify({ error: null })
		}).catch((e) => {
			if (threadId !== this.state.currentThreadId) notify({ error: getErrorMessage(e) })
			throw e
		})
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		this._cancelCompaction(threadId, 'user')

		// interrupt existing stream
		if (this.streamState[threadId]?.isRunning) {
			await this.abortRunning(threadId)
		}

		// add dummy before this message to keep checkpoint before user message idea consistent
		if (thread.messages.length === 0) {
			this._addUserCheckpoint({ threadId })
		}


		// add user's message to chat history
		const instructions = userMessage
		const currSelns: StagingSelectionItem[] = _chatSelections ?? thread.state.stagingSelections

		const userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }) // user message + names of files (NOT content)
		const userHistoryElt: ChatMessage = { role: 'user', content: userMessageContent, displayContent: instructions, selections: currSelns, state: defaultMessageState }
		this._addMessageToThread(threadId, userHistoryElt)

		this._setThreadState(threadId, { currCheckpointIdx: null }) // no longer at a checkpoint because started streaming

		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), }),
			threadId,
		)

		// scroll to bottom
		this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
			m.scrollToBottom()
		})
	}


	async addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) return
		if (this._refuseIfWorktreeRemoved(threadId)) return

		// if there's a current checkpoint, delete all messages after it
		if (thread.state.currCheckpointIdx !== null) {
			const checkpointIdx = thread.state.currCheckpointIdx;
			const newMessages = thread.messages.slice(0, checkpointIdx + 1);

			// Update the thread with truncated messages
			const newThreads = {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					lastModified: new Date().toISOString(),
					messages: newMessages,
					compaction: compactionAfterCut(thread.compaction, newMessages.length),
				}
			};
			this._storeAllThreads(newThreads);
			this._setState({ allThreads: newThreads });
		}

		// Now call the original method to add the user message and stream the response
		await this._addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId });

	}

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {

		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen
		if (this._refuseIfWorktreeRemoved(threadId)) return

		if (thread.messages?.[messageIdx]?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`)
		}

		// get prev and curr selections before clearing the message
		const currSelns = thread.messages[messageIdx].state.stagingSelections || [] // staging selections for the edited message

		// clear messages up to the index
		const slicedMessages = thread.messages.slice(0, messageIdx)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					messages: slicedMessages,
					compaction: compactionAfterCut(thread.compaction, slicedMessages.length),
				}
			}
		})

		// re-add the message and stream it
		this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, threadId })
	}

	private readonly _compacting = new Map<string, { requestId?: string, stoppedBecause?: 'user' | 'timeout' }>()
	isCompacting(threadId: string) { return this._compacting.has(threadId) }

	/** the user sent a message on this chat: the summary in flight is no longer wanted */
	private _cancelCompaction(threadId: string, why: 'user' | 'timeout') {
		const c = this._compacting.get(threadId)
		if (!c) return
		c.stoppedBecause = why
		if (c.requestId) this._llmMessageService.abort(c.requestId)
	}

	async compactThread(threadId: string): Promise<void> {
		const thread = this.state.allThreads[threadId]
		if (!thread || this.streamState[threadId]?.isRunning || this._compacting.has(threadId)) return
		const cut = compactionCut(thread.messages)
		if (cut === null) {
			this._notificationService.info('Nothing to compact yet.')
			return
		}
		const messageAtCut = thread.messages[cut]
		const entry: { requestId?: string, stoppedBecause?: 'user' | 'timeout' } = {}
		this._compacting.set(threadId, entry)
		this._onDidChangeCurrentThread.fire()
		const timer = setTimeout(() => this._cancelCompaction(threadId, 'timeout'), COMPACT_TIMEOUT_MS)
		try {
			const { modelSelection, modelSelectionOptions } = this._currentModelSelectionProps()
			const { messages, separateSystemMessage } = this._convertToLLMMessagesService.prepareLLMSimpleMessages({
				simpleMessages: [{ role: 'user', content: compactionTranscript(thread.messages.slice(0, cut)) }],
				systemMessage: COMPACT_SYSTEM_PROMPT,
				modelSelection,
				featureName: 'Chat',
			})
			const summary = await new Promise<string>((resolve, reject) => {
				const requestId = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					messages,
					separateSystemMessage,
					chatMode: null,
					toolPolicy: null,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel: this._settingsService.state.overridesOfModel,
					onText: () => { },
					onFinalMessage: ({ fullText }) => resolve(fullText.trim()),
					onError: (e) => reject(new Error(e.message)),
					onAbort: () => reject(new Error('cancelled')),
					logging: { loggingName: 'ZeroEgress - Compact' },
				})
				if (!requestId) { reject(new Error('no model is selected')); return }
				entry.requestId = requestId
				if (entry.stoppedBecause) this._llmMessageService.abort(requestId)
			})
			if (entry.stoppedBecause === 'user') return
			if (!summary) throw new Error('the model returned no summary')
			const latest = this.state.allThreads[threadId]
			// the chat changed while the summary was written (restored, edited): drop it, the user already moved on
			if (!latest || !compactionStillValid(latest.messages, cut, messageAtCut)) return
			const newThreads = {
				...this.state.allThreads,
				[threadId]: { ...latest, compaction: { summary, uptoIdx: cut, at: new Date().toISOString() } },
			}
			this._storeAllThreads(newThreads)
			this._setState({ allThreads: newThreads })
		} catch (e) {
			if (entry.stoppedBecause === 'user') return
			const msg = entry.stoppedBecause === 'timeout' ? 'it took too long.' : getErrorMessage(e)
			this._notificationService.error(`Couldn't compact this chat: ${msg}`)
		} finally {
			clearTimeout(timer)
			this._compacting.delete(threadId)
			this._onDidChangeCurrentThread.fire()
		}
	}

	// ---------- the rest ----------

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []

		const fsPathsSet = new Set<string>()
		const uris: URI[] = []
		const addURI = (uri: URI) => {
			if (!fsPathsSet.has(uri.fsPath)) uris.push(uri)
			fsPathsSet.add(uri.fsPath)
			uris.push(uri)
		}

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					addURI(sel.uri)
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && m.name === 'read_file') {
				const params = m.params as BuiltinToolCallParams['read_file']
				addURI(params.uri)
			}
		}
		return uris
	}



	getRelativeStr = (uri: URI) => {
		const isInside = this._workspaceContextService.isInsideWorkspace(uri)
		if (isInside) {
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath))
			if (f) { return uri.fsPath.replace(f.uri.fsPath, '') }
			else { return undefined }
		}
		else {
			return undefined
		}
	}


	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class'
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder'
			target = _codespanStr

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class'
			target = _codespanStr

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern)
			if (match && match[1]) {

				codespanType = 'function-or-class'
				target = match[1]

			}
			else { return null }
		}
		else {
			return null
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse()

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target)

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}

					return { uri, displayText }
				}
			}

			// else search codebase for `target`
			let uris: URI[] = []
			try {
				const { result } = await this._toolsService.callTool['search_pathnames_only']({ query: target, includePattern: null, pageNumber: 0 }, { kind: 'docked' })
				const { uris: uris_ } = await result
				uris = uris_
			} catch (e) {
				return null
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}


					return { uri, displayText }
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._zeroEgressModelService.getModelSafe(uri)
				const { model } = modelRef
				if (!model) continue

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) continue;

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};

							// const defModelRef = await this._textModelService.createModelReference(definition.uri);
							// const defModel = defModelRef.object.textEditorModel;

							// try {
							// 	const symbolProviders = this._languageFeaturesService.documentSymbolProvider.ordered(defModel);

							// 	for (const symbolProvider of symbolProviders) {
							// 		const symbols = await symbolProvider.provideDocumentSymbols(
							// 			defModel,
							// 			CancellationToken.None
							// 		);

							// 		if (symbols) {
							// 			const symbol = symbols.find(s => {
							// 				const symbolRange = s.range;
							// 				return symbolRange.startLineNumber <= definition.range.startLineNumber &&
							// 					symbolRange.endLineNumber >= definition.range.endLineNumber &&
							// 					(symbolRange.startLineNumber !== definition.range.startLineNumber || symbolRange.startColumn <= definition.range.startColumn) &&
							// 					(symbolRange.endLineNumber !== definition.range.endLineNumber || symbolRange.endColumn >= definition.range.endColumn);
							// 			});

							// 			// if we got to a class/function get the full range and return
							// 			if (symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Method || symbol?.kind === SymbolKind.Class) {
							// 				return {
							// 					uri: definition.uri,
							// 					selection: {
							// 						startLineNumber: definition.range.startLineNumber,
							// 						startColumn: definition.range.startColumn,
							// 						endLineNumber: definition.range.endLineNumber,
							// 						endColumn: definition.range.endColumn,
							// 					}
							// 				};
							// 			}
							// 		}
							// 	}
							// } finally {
							// 	defModelRef.dispose();
							// }
						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null

	}

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined;

		const links = thread.state.linksOfMessageIdx?.[messageIdx]
		if (!links) return undefined;

		const link = links[codespanStr]

		return link
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({

			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		})
	}


	getCurrentThread(): ThreadType {
		const state = this.state
		const thread = state.allThreads[state.currentThreadId]
		if (!thread) throw new Error(`Current thread should never be undefined`)
		return thread
	}

	getCurrentFocusedMessageIdx(threadId?: string) {
		const thread = threadId === undefined ? this.getCurrentThread() : this.state.allThreads[threadId]
		if (!thread) return

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx
		if (focusedMessageIdx === undefined) return;

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx]
		if (focusedMessage.role !== 'user') return;
		if (!focusedMessage.state) return;

		return focusedMessageIdx
	}

	isCurrentlyFocusingMessage(threadId?: string) {
		return this.getCurrentFocusedMessageIdx(threadId) !== undefined
	}

	switchToThread(threadId: string) {
		if (this.state.allThreads[threadId]?.agent) return // background agents are never the docked thread
		this._setState({ currentThreadId: threadId, openTabIds: this._tabsWith(threadId) })
	}


	openNewThread() {
		// if a thread with 0 messages already exists, switch to it; otherwise start a new thread
		const { threads, id, created } = this._emptyThreadIn(this.state.allThreads)
		if (!created) {
			this.switchToThread(id)
			return
		}
		this._storeAllThreads(threads)
		this._setState({ allThreads: threads, currentThreadId: id, openTabIds: this._tabsWith(id, threads) })
	}


	renameThread(threadId: string, title: string): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const trimmed = title.trim()
		const { title: _previous, ...rest } = thread
		const newThread: ThreadType = trimmed ? { ...rest, title: trimmed } : rest
		const newThreads: ChatThreads = { ...this.state.allThreads, [threadId]: newThread }
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}


	closeTab(threadId: string): void {
		const { tabs, next } = closeTabOf(this.state.openTabIds, threadId, this.state.currentThreadId)
		this._setState({ openTabIds: tabs })
		if (next === undefined) {
			this.openNewThread()
		} else if (next !== this.state.currentThreadId) {
			this.switchToThread(next)
		}
	}


	async deleteThread(threadId: string): Promise<void> {
		// a running chat stops first: its tool calls end and its model slot (or queued wait) is freed
		if (this.streamState[threadId]?.isRunning) {
			await this.abortRunning(threadId)
		}
		if (!this.state.allThreads[threadId]) return // deleted meanwhile

		// delete the thread
		let newThreads: ChatThreads = { ...this.state.allThreads };
		delete newThreads[threadId];

		// its tab goes too; if it was the docked thread, move to a neighbouring tab, else to an empty or new chat,
		// in the same update, so the docked thread is never a deleted one
		let { tabs, next } = closeTabOf(this.state.openTabIds, threadId, this.state.currentThreadId)
		if (next === undefined) {
			const empty = this._emptyThreadIn(newThreads)
			newThreads = empty.threads
			next = empty.id
			tabs = openTab(tabs, next, id => !!this.streamState[id]?.isRunning)
		}

		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads, openTabIds: tabs, currentThreadId: next })

		// its unreviewed changes stay, now owned by no chat (every tab shows them as from other chats)
		this._changeOwnersService.releaseThread(threadId)
	}

	startBackgroundThread(agent: BackgroundAgentInfo, messages: ChatMessage[], prompt: string): string {
		// the prompt goes in synchronously (no selections, so its content is the prompt itself), and the run starts in the same tick,
		// so the thread never shows as idle without a message, and a delete right away finds the run to abort
		const userMessage: ChatMessage = { role: 'user', content: prompt, displayContent: prompt, selections: [], state: defaultMessageState }
		const newThread: ThreadType = { ...newThreadObject(), agent, messages: [...messages, userMessage] }
		const newThreads: ChatThreads = { ...this.state.allThreads, [newThread.id]: newThread }
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current (docked) thread stays as it is
		this._wrapRunAgentToNotify(this._runChatAgent({ threadId: newThread.id, ...this._currentModelSelectionProps() }), newThread.id)
		return newThread.id
	}

	setBackgroundAgentInfo(threadId: string, agent: BackgroundAgentInfo): void {
		const thread = this.state.allThreads[threadId]
		if (!thread?.agent) return
		const newThreads: ChatThreads = { ...this.state.allThreads, [threadId]: { ...thread, agent } }
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}

	/** a follow-up to a background agent whose worktree was removed is refused */
	private _refuseIfWorktreeRemoved(threadId: string): boolean {
		const agent = this.state.allThreads[threadId]?.agent
		if (!agent || agent.worktreePath) return false
		this._setStreamState(threadId, { isRunning: undefined, error: { message: AGENT_WORKTREE_REMOVED_MESSAGE, fullError: null } })
		return true
	}

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state
		const threadToDuplicate = currentThreads[threadId]
		if (!threadToDuplicate || threadToDuplicate.agent) return
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		}
		const newThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
		this.switchToThread(newThread.id) // the copy opens in its own tab
	}


	private _addMessageToThread(threadId: string, message: ChatMessage) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages,
					message
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined, threadId: string = this.state.currentThreadId) {

		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		})

		// // when change focused message idx, jump - do not jump back when click edit, too confusing.
		// if (messageIdx !== undefined)
		// 	this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: true })
	}


	addNewStagingSelection(newSelection: StagingSelectionItem): void {

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection)
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			])
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection])
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		])

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number, threadId: string = this.state.currentThreadId): void {

		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		})

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo)

	}


	// closeCurrentStagingSelectionsInThread = () => {
	// 	const currThread = this.getCurrentThreadState()

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currThread.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newThread = currThread
	// 	newThread.stagingSelections = closedStagingSelections

	// 	this.setCurrentThreadState(newThread)

	// }

	// closeCurrentStagingSelectionsInMessage: IChatThreadService['closeCurrentStagingSelectionsInMessage'] = ({ messageIdx }) => {
	// 	const currMessage = this.getCurrentMessageState(messageIdx)

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currMessage.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newMessage = currMessage
	// 	newMessage.stagingSelections = closedStagingSelections

	// 	this.setCurrentMessageState(messageIdx, newMessage)

	// }



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread()
		return currentThread.state
	}
	setCurrentThreadState = (newState: Partial<ThreadType['state']>, threadId: string = this.state.currentThreadId) => {
		this._setThreadState(threadId, newState)
	}

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number, threadId: string = this.state.currentThreadId): UserMessageState {
		const currMessage = this.state.allThreads[threadId]?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return defaultMessageState
		return currMessage.state
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>, threadId: string = this.state.currentThreadId) {
		const currMessage = this.state.allThreads[threadId]?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return
		this._setCurrentMessageState(newState, messageIdx, threadId)
	}



}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
