/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { acceptHunk as acceptHunkText, computeHunks, decodeReviewText, FileReview, HunkState, linesMatch, minimalEdit, rejectHunk as rejectHunkText, reviewFile } from '../common/agentReview.js';
import { agentStatus } from '../common/agentStatus.js';
import { agentRootOf, BackgroundAgentInfo } from '../common/backgroundAgentTypes.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { ChangedFile, IZeroEgressWorktreeService, WORKTREE_CHANNEL } from '../common/worktreeTypes.js';
import { AGENTS_SETUP_COMMAND_SETTING } from '../common/zeroEgressConfiguration.js';
import { IChatThreadService } from './chatThreadService.js';
import { AgentSummary, BACKGROUND_AGENTS_UNAVAILABLE, IBackgroundAgentsService } from './backgroundAgentsServiceInterface.js';

export type { AgentSummary } from './backgroundAgentsServiceInterface.js';
export { BACKGROUND_AGENTS_UNAVAILABLE, FILE_CONFLICT_ACCEPT_TOOLTIP, IBackgroundAgentsService } from './backgroundAgentsServiceInterface.js';

const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
/** the setup command the user last approved for this workspace; a different (or first) command asks again */
const SETUP_APPROVED_KEY = 'zeroEgress.agents.approvedSetupCommand';
const TITLE_MAX = 60;

/** One changed file, read fresh: base (after overrides), the agent's text and the user's current text. */
interface FileState {
	agent: BackgroundAgentInfo;
	file: ChangedFile;
	base: string | null;
	agentText: string | null;
	current: string | null;
	review: FileReview;
}

export const titleOfMessages = (messages: readonly ChatMessage[]): string => {
	const first = messages.find(m => m.role === 'user');
	const text = first?.role === 'user' ? first.displayContent : '';
	return (text.split(/\r?\n/)[0] ?? '').trim().slice(0, TITLE_MAX);
};

export class BackgroundAgentsService extends Disposable implements IBackgroundAgentsService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _worktree: IZeroEgressWorktreeService;
	private _agents: AgentSummary[] = [];
	private _agentsKey = '';
	/** pending-file count per thread, refreshed when a run ends and after every review write */
	private readonly _pending = new Map<string, number>();
	/** threads whose run was active at the last stream-state change */
	private readonly _running = new Set<string>();
	/** threads that reached 0 pending files while running; cleaned up when the run ends */
	private readonly _cleanupWhenIdle = new Set<string>();
	/** review writes are serialized per thread so quick clicks can't interleave read-modify-write */
	private readonly _queues = new Map<string, Promise<unknown>>();
	/** startup prune; starting an agent waits for it so a fresh worktree is never pruned */
	private readonly _ready: Promise<void>;

	constructor(
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._worktree = ProxyChannel.toService<IZeroEgressWorktreeService>(mainProcessService.getChannel(WORKTREE_CHANNEL));

		this._register(this._chatThreadService.onDidChangeStreamState(({ threadId }) => this._onStreamState(threadId)));
		this._register(this._chatThreadService.onDidChangeCurrentThread(() => this._recompute()));
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => this._recompute()));

		this._ready = this._init().catch(onUnexpectedError);
		this._recompute();
	}

	// ---------- list ----------

	get agents(): readonly AgentSummary[] {
		return this._agents;
	}

	private _agentThreads() {
		return Object.values(this._chatThreadService.state.allThreads).filter(t => !!t?.agent).map(t => t!);
	}

	/** the single `file:` workspace folder, or undefined */
	private _folder() {
		const folders = this._workspaceContextService.getWorkspace().folders;
		return folders.length === 1 && folders[0].uri.scheme === Schemas.file ? folders[0] : undefined;
	}

	/** running, waiting, or waiting for the user's OK (also after a restart, when only the last message says so) */
	private _isActive(threadId: string): boolean {
		if (this._chatThreadService.streamState[threadId]?.isRunning) { return true; }
		const messages = this._chatThreadService.state.allThreads[threadId]?.messages ?? [];
		const last = messages[messages.length - 1];
		return last?.role === 'tool' && last.type === 'tool_request';
	}

	private _recompute(): void {
		const userRoot = this._folder()?.uri.fsPath;
		const rows: { createdAt: string; summary: AgentSummary }[] = [];
		for (const thread of this._agentThreads()) {
			const agent = thread.agent!;
			if (agent.userRoot !== userRoot) { continue; }
			const stream = this._chatThreadService.streamState[thread.id];
			const removed = !agent.worktreePath;
			let isRunning = stream?.isRunning;
			if (!isRunning && this._isActive(thread.id)) { isRunning = 'awaiting_user'; }
			const pendingFiles = removed ? 0 : this._pending.get(thread.id) ?? 0;
			rows.push({
				createdAt: thread.createdAt,
				summary: {
					threadId: thread.id,
					title: titleOfMessages(thread.messages),
					status: agentStatus({ isRunning, hasError: !removed && !!stream?.error, pendingFiles }),
					changedFiles: pendingFiles,
				},
			});
		}
		rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
		const agents = rows.map(r => r.summary);
		const key = JSON.stringify(agents);
		if (key === this._agentsKey) { return; }
		this._agentsKey = key;
		this._agents = agents;
		this._onDidChange.fire();
	}

	private _onStreamState(threadId: string): void {
		const thread = this._chatThreadService.state.allThreads[threadId];
		if (!thread?.agent) { return; }
		const isRunning = this._chatThreadService.streamState[threadId]?.isRunning;
		const working = !!isRunning && isRunning !== 'awaiting_user';
		const wasWorking = this._running.has(threadId);
		if (working) { this._running.add(threadId); } else { this._running.delete(threadId); }
		this._recompute();
		if (wasWorking && !working) {
			// the run ended (or paused for approval): refresh the count, and clean up if everything was settled during the run
			this._enqueue(threadId, () => this._refresh(threadId, this._cleanupWhenIdle.has(threadId))).catch(onUnexpectedError);
		}
	}

	// ---------- lifecycle ----------

	private async _init(): Promise<void> {
		const availability = await this.availability();
		if (availability.ok) {
			const folder = this._folder()!;
			const info = await this._worktree.repoInfo(folder.uri.fsPath);
			if (info) {
				// a thread whose worktree was already removed keeps nothing alive (a failed removal is retried here)
				const keep = this._agentThreads().filter(t => !!t.agent!.worktreePath).map(t => t.agent!.agentId);
				await this._worktree.prune(info.repoRoot, keep).catch(onUnexpectedError);
			}
		}
		const userRoot = this._folder()?.uri.fsPath;
		for (const thread of this._agentThreads()) {
			if (thread.agent!.userRoot === userRoot && thread.agent!.worktreePath) {
				await this._enqueue(thread.id, () => this._refresh(thread.id, false)).catch(onUnexpectedError);
			}
		}
	}

	async availability(): Promise<{ ok: true } | { ok: false; reason: string }> {
		const folder = this._folder();
		if (!folder) { return { ok: false, reason: BACKGROUND_AGENTS_UNAVAILABLE }; }
		const info = await this._worktree.repoInfo(folder.uri.fsPath).catch(() => null);
		return info ? { ok: true } : { ok: false, reason: BACKGROUND_AGENTS_UNAVAILABLE };
	}

	async startAgent(prompt: string, fromThreadId?: string): Promise<string> {
		await this._ready;
		const folder = this._folder();
		const info = folder ? await this._worktree.repoInfo(folder.uri.fsPath).catch(() => null) : null;
		if (!folder || !info) { throw new Error(BACKGROUND_AGENTS_UNAVAILABLE); }

		// the setting may come from the repo's .vscode/settings.json: never run a command the user hasn't seen
		let command = (this._configurationService.getValue<string>(AGENTS_SETUP_COMMAND_SETTING, { resource: folder.uri }) ?? '').trim();
		if (command && !await this._approveSetup(command)) { command = ''; }

		const agentId = generateUuid().replace(/-/g, '').slice(0, 8);
		const created = await this._worktree.create(info.repoRoot, agentId);
		const agent: BackgroundAgentInfo = {
			agentId,
			repoRoot: info.repoRoot,
			subdir: info.subdir,
			userRoot: folder.uri.fsPath,
			worktreePath: created.worktreePath,
			branch: created.branch,
			baseCommit: created.baseCommit,
			setup: null,
		};

		try {
			if (command) {
				const { exitCode, outputTail } = await this._worktree.runSetup(agentRootOf(agent), command, SETUP_TIMEOUT_MS);
				agent.setup = { command, exitCode, outputTail };
			}
		} catch (e) {
			await this._worktree.remove(agent.repoRoot, agentId).catch(onUnexpectedError);
			throw e;
		}

		let messages: ChatMessage[] = [];
		let userMessage = prompt;
		if (fromThreadId) {
			messages = (this._chatThreadService.state.allThreads[fromThreadId]?.messages ?? []).filter(m => m.role !== 'checkpoint');
			userMessage = `Continue the task above using your tools. Your working folder is now ${agentRootOf(agent)}; paths under ${agent.userRoot} in earlier messages refer to the same files there.`;
		}
		const threadId = this._chatThreadService.startBackgroundThread(agent, messages, userMessage);
		this._pending.set(threadId, 0);
		this._recompute();
		return threadId;
	}

	/** asks before the first run of a setup command in this workspace, and again whenever it changes; declined: no setup */
	private async _approveSetup(command: string): Promise<boolean> {
		if (this._storageService.get(SETUP_APPROVED_KEY, StorageScope.WORKSPACE) === command) { return true; }
		const { confirmed } = await this._dialogService.confirm({
			type: 'warning',
			message: `Run this setup command in the agent's worktree?`,
			detail: `${command}\n\nIt comes from the setting ${AGENTS_SETUP_COMMAND_SETTING}, runs with a shell, and is not covered by the network guard. If you don't run it, the agent starts without setup.`,
			primaryButton: '&&Run',
			cancelButton: `Don't Run`,
		});
		if (confirmed) { this._storageService.store(SETUP_APPROVED_KEY, command, StorageScope.WORKSPACE, StorageTarget.MACHINE); }
		return confirmed;
	}

	async deleteAgent(threadId: string): Promise<void> {
		const agent = this._chatThreadService.state.allThreads[threadId]?.agent;
		if (!agent) { return; }
		await this._chatThreadService.abortRunning(threadId); // also leaves a queued wait
		await this._enqueue(threadId, async () => {
			await this._worktree.remove(agent.repoRoot, agent.agentId);
			this._chatThreadService.deleteThread(threadId);
		});
		this._pending.delete(threadId);
		this._running.delete(threadId);
		this._cleanupWhenIdle.delete(threadId);
		this._recompute();
	}

	// ---------- review reads ----------

	private _agentOf(threadId: string): BackgroundAgentInfo | undefined {
		const agent = this._chatThreadService.state.allThreads[threadId]?.agent;
		return agent?.worktreePath ? agent : undefined;
	}

	/**
	 * The user's file for a repo-relative path. Built from the workspace folder rather than `repoRoot`: git reports the
	 * real path (`/private/tmp/...` for `/tmp/...` on macOS), and only the folder's spelling matches open text models.
	 */
	private _userUri(agent: BackgroundAgentInfo, path: string): URI {
		const inFolder = agent.subdir && path.startsWith(agent.subdir + '/') ? path.slice(agent.subdir.length + 1) : agent.subdir ? undefined : path;
		return URI.file(inFolder !== undefined ? join(agent.userRoot, inFolder) : join(agent.repoRoot, path));
	}

	private _worktreeUri(agent: BackgroundAgentInfo, path: string): URI {
		return URI.file(join(agent.worktreePath, path));
	}

	/**
	 * The file's text with any UTF-8 BOM stripped (`bom` says it had one); `null` when it does not exist; `undefined` when its
	 * bytes are not valid UTF-8 (reviewed as binary, never decoded lossily and written back).
	 */
	private async _readDiskText(uri: URI): Promise<{ text: string; bom: boolean } | null | undefined> {
		let bytes: Uint8Array;
		try {
			bytes = (await this._fileService.readFile(uri)).value.buffer;
		} catch {
			return null;
		}
		return decodeReviewText(bytes);
	}

	private async _readDisk(uri: URI): Promise<string | null | undefined> {
		const d = await this._readDiskText(uri);
		return d ? d.text : d;
	}

	/** writes `text`, with a BOM when `bom` */
	private async _writeDisk(uri: URI, text: string, bom: boolean): Promise<void> {
		await this._fileService.writeFile(uri, VSBuffer.fromString(bom ? `\ufeff${text}` : text));
	}

	/** the open text model's value if any, else the disk file, else null */
	private async _readCurrent(uri: URI): Promise<string | null | undefined> {
		const model = this._modelService.getModel(uri);
		if (model) { return model.getValue(); }
		return this._readDisk(uri);
	}

	private async _readFile(agent: BackgroundAgentInfo, file: ChangedFile): Promise<FileState> {
		if (!file.binary) {
			const [base, agentText, current] = await Promise.all([
				this._worktree.readBase(agent.agentId, agent.worktreePath, agent.baseCommit, file.path),
				file.status === 'D' ? Promise.resolve(null) : this._readDisk(this._worktreeUri(agent, file.path)),
				this._readCurrent(this._userUri(agent, file.path)),
			]);
			if (agentText !== undefined && current !== undefined) {
				return { agent, file, base, agentText, current, review: reviewFile(file.path, base, agentText, current, false) };
			}
			file = { ...file, binary: true }; // the agent's or the user's bytes are not UTF-8
		}
		return { agent, file, base: null, agentText: null, current: null, review: await this._binaryReview(agent, file.path) };
	}

	/** a binary file is a file-level conflict when the user's file no longer has the bytes the agent started from */
	private async _binaryReview(agent: BackgroundAgentInfo, path: string): Promise<FileReview> {
		const matches = await this._userMatchesBase(agent, path);
		return { ...reviewFile(path, null, null, null, true), fileConflict: !matches };
	}

	private _userMatchesBase(agent: BackgroundAgentInfo, path: string): Promise<boolean> {
		return this._worktree.userFileMatchesBase(agent.agentId, agent.worktreePath, agent.baseCommit, path, this._userUri(agent, path).fsPath);
	}

	/**
	 * binary: still listed by changedFiles. text: base (after overrides) differs from the agent's text by a line; a missing
	 * trailing newline or CRLF vs LF alone shows no hunk, so it would otherwise stay pending forever.
	 */
	private _isPending(s: FileState): boolean {
		return s.file.binary || !linesMatch(s.base, s.agentText);
	}

	private async _pendingFiles(agent: BackgroundAgentInfo): Promise<FileState[]> {
		const files = await this._worktree.changedFiles(agent.worktreePath, agent.baseCommit, agent.subdir);
		const states = await Promise.all(files.map(f => this._readFile(agent, f)));
		return states.filter(s => this._isPending(s));
	}

	/** one file, read fresh; undefined when it is not (or no longer) pending */
	private async _fileState(agent: BackgroundAgentInfo, path: string): Promise<FileState | undefined> {
		const files = await this._worktree.changedFiles(agent.worktreePath, agent.baseCommit, agent.subdir);
		const file = files.find(f => f.path === path);
		if (!file) { return undefined; }
		const s = await this._readFile(agent, file);
		return this._isPending(s) ? s : undefined;
	}

	async getReview(threadId: string): Promise<FileReview[]> {
		const agent = this._agentOf(threadId);
		if (!agent) { return []; }
		const pending = await this._pendingFiles(agent);
		if (this._agentOf(threadId) && this._pending.get(threadId) !== pending.length) {
			this._pending.set(threadId, pending.length);
			this._recompute();
		}
		return pending.map(s => s.review);
	}

	// ---------- review writes ----------

	private _enqueue<T>(threadId: string, task: () => Promise<T>): Promise<T> {
		const previous = this._queues.get(threadId) ?? Promise.resolve();
		const next = previous.catch(() => { }).then(task);
		this._queues.set(threadId, next);
		next.finally(() => { if (this._queues.get(threadId) === next) { this._queues.delete(threadId); } }).catch(() => { });
		return next;
	}

	/** runs `write` on a fresh read of the file, then refreshes the count and cleans up if nothing is left */
	private _write(threadId: string, path: string, write: (s: FileState) => Promise<void>): Promise<void> {
		return this._enqueue(threadId, async () => {
			const agent = this._agentOf(threadId);
			if (!agent) { return; }
			const s = await this._fileState(agent, path);
			if (s) { await write(s); }
			await this._refresh(threadId, true);
		});
	}

	/** recounts pending files; with `cleanup`, removes the worktree once nothing is pending and the agent is idle */
	private async _refresh(threadId: string, cleanup: boolean): Promise<void> {
		const agent = this._agentOf(threadId);
		if (!agent) { this._recompute(); return; }
		const count = (await this._pendingFiles(agent)).length;
		this._pending.set(threadId, count);
		if (cleanup && count === 0) {
			if (this._isActive(threadId)) {
				this._cleanupWhenIdle.add(threadId);
			} else {
				this._cleanupWhenIdle.delete(threadId);
				// marked removed first, so a follow-up sent while git removes the worktree is refused
				const latest = this._chatThreadService.state.allThreads[threadId]?.agent;
				if (latest) { this._chatThreadService.setBackgroundAgentInfo(threadId, { ...latest, worktreePath: '' }); }
				this._pending.delete(threadId);
				await this._worktree.remove(agent.repoRoot, agent.agentId);
			}
		} else if (count > 0) {
			this._cleanupWhenIdle.delete(threadId);
		}
		this._recompute();
	}

	private _openModel(uri: URI) {
		const model = this._modelService.getModel(uri);
		return model && !model.isDisposed() ? model : undefined;
	}

	/** whether the user's text is still `expected` (the text a merge was computed from): the open model's value, else the disk file */
	private async _currentIs(uri: URI, expected: string | null): Promise<boolean> {
		const model = this._openModel(uri);
		if (model) { return model.getValue() === expected; }
		const disk = await this._readDisk(uri);
		// a model may have been opened (and typed in) while the disk was read
		const opened = this._openModel(uri);
		return (opened ? opened.getValue() : disk) === expected;
	}

	/**
	 * Writes the user's file: through the open text model (one undoable edit, saved only if it was clean), else to disk. `null` deletes it.
	 * `expected` is the user's text the change was computed from; if the user's text is no longer that (typed during the awaits),
	 * nothing is written and this returns false, so the caller leaves the base alone and the file stays pending.
	 */
	private async _writeUser(uri: URI, expected: string | null, text: string | null): Promise<boolean> {
		const model = this._openModel(uri);
		if (model) {
			// check and edit in the same tick: no keystroke can land in between
			if (model.getValue() !== expected) { return false; }
			if (text === null) {
				await this._fileService.del(uri, { useTrash: true });
				return true;
			}
			const wasDirty = this._textFileService.isDirty(uri);
			// only the changed lines: cursors, folding and other diff zones elsewhere in the file stay put
			const edit = minimalEdit(expected ?? '', text);
			if (edit.start !== edit.end || edit.text) {
				const range = Range.fromPositions(model.getPositionAt(edit.start), model.getPositionAt(edit.end));
				model.pushStackElement();
				model.pushEditOperations([], [{ range, text: edit.text }], () => null);
				model.pushStackElement();
			}
			if (!wasDirty) { await this._textFileService.save(uri); }
			return true;
		}
		const disk = await this._readDiskText(uri);
		if (this._openModel(uri)) { return this._writeUser(uri, expected, text); } // opened meanwhile: go through the model
		if ((disk ? disk.text : disk) !== expected) { return false; }
		if (text === null) {
			if (disk !== null) { await this._fileService.del(uri, { useTrash: true }); }
			return true;
		}
		await this._writeDisk(uri, text, !!disk?.bom);
		return true;
	}

	/** Writes the agent's file in the worktree. `null` deletes it. */
	private async _writeWorktree(agent: BackgroundAgentInfo, path: string, text: string | null): Promise<void> {
		const uri = this._worktreeUri(agent, path);
		if (text === null) {
			if (await this._fileService.exists(uri)) { await this._fileService.del(uri, { useTrash: false }); }
			return;
		}
		const old = await this._readDiskText(uri);
		await this._writeDisk(uri, text, !!old?.bom);
	}

	private async _acceptBinary(s: FileState): Promise<void> {
		const { agent, file } = s;
		const user = this._userUri(agent, file.path);
		// checked again right before the copy: the user may have changed the file since the review was read
		if (!await this._userMatchesBase(agent, file.path)) { return; }
		if (file.status === 'D') {
			if (await this._fileService.exists(user)) { await this._fileService.del(user, { useTrash: true }); }
		} else {
			await this._fileService.copy(this._worktreeUri(agent, file.path), user, true);
		}
		await this._worktree.resolveBinary(agent.agentId, agent.worktreePath, agent.baseCommit, file.path, 'accept');
	}

	/** Accepts a whole file; for a modified file, its clean hunks (conflicts stay pending). Never touches a file-level conflict. */
	private async _acceptWhole(s: FileState): Promise<void> {
		const { agent, file, review } = s;
		if (review.fileConflict) { return; }
		if (file.binary) { return this._acceptBinary(s); }
		const user = this._userUri(agent, file.path);
		if (review.kind === 'added') {
			const ok = s.current === s.agentText ? await this._currentIs(user, s.current) : await this._writeUser(user, s.current, s.agentText);
			if (!ok) { return; }
			await this._worktree.writeBase(agent.agentId, file.path, s.agentText);
			return;
		}
		if (review.kind === 'deleted') {
			const ok = s.current === null ? await this._currentIs(user, null) : await this._writeUser(user, s.current, null);
			if (!ok) { return; }
			await this._worktree.writeBase(agent.agentId, file.path, null);
			return;
		}
		// modified: apply clean hunks one at a time, re-reviewing in memory after each
		if (s.base === null || s.agentText === null || s.current === null) { return; }
		let base = s.base;
		let current = s.current;
		for (let guard = 0; guard < 10000; guard++) {
			const next = reviewFile(file.path, base, s.agentText, current, false).hunks.find(h => h.status === 'clean');
			if (!next) { break; }
			({ base, current } = acceptHunkText(next, base, current));
		}
		// no hunk left but the texts still differ (trailing newline, line endings): the agent's text becomes the base as is
		const noneLeft = computeHunks(base, s.agentText).length === 0;
		if (base === s.base && !noneLeft) { return; }
		if (current !== s.current && !await this._writeUser(user, s.current, current)) { return; }
		await this._worktree.writeBase(agent.agentId, file.path, noneLeft ? s.agentText : base);
	}

	/** Rejects the whole file (restores the base in the worktree), or with `onlyClean` just a modified file's clean hunks. */
	private async _rejectWhole(s: FileState, onlyClean: boolean): Promise<void> {
		const { agent, file, review } = s;
		if (onlyClean && review.fileConflict) { return; }
		if (file.binary) {
			await this._worktree.resolveBinary(agent.agentId, agent.worktreePath, agent.baseCommit, file.path, 'reject');
			return;
		}
		if (!onlyClean || review.kind !== 'modified') {
			await this._writeWorktree(agent, file.path, s.base);
			return;
		}
		if (s.base === null || s.agentText === null || s.current === null) { return; }
		let agentText = s.agentText;
		for (let guard = 0; guard < 10000; guard++) {
			const next = reviewFile(file.path, s.base, agentText, s.current, false).hunks.find(h => h.status === 'clean');
			if (!next) { break; }
			agentText = rejectHunkText(next.hunk, agentText);
		}
		// no hunk left but the texts still differ (trailing newline, line endings): the base becomes the agent's text as is
		if (computeHunks(s.base, agentText).length === 0) { agentText = s.base; }
		if (agentText !== s.agentText) { await this._writeWorktree(agent, file.path, agentText); }
	}

	/** the fresh hunk identical to the one the UI rendered, if any */
	private _freshHunk(review: FileReview, rendered: HunkState): HunkState | undefined {
		const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((l, i) => l === b[i]);
		return review.hunks.find(h =>
			h.status === rendered.status
			&& h.hunk.baseStart === rendered.hunk.baseStart
			&& same(h.hunk.baseLines, rendered.hunk.baseLines)
			&& same(h.hunk.agentLines, rendered.hunk.agentLines)
			&& (h.status !== 'conflict' || rendered.status !== 'conflict' || same(h.currentLines, rendered.currentLines)));
	}

	acceptHunk(threadId: string, path: string, rendered: HunkState): Promise<void> {
		return this._write(threadId, path, async s => {
			const { agent, review } = s;
			const state = this._freshHunk(review, rendered);
			if (!state || review.fileConflict || s.file.binary) { return; }
			if (review.kind !== 'modified') { return this._acceptWhole(s); } // an added/deleted file's single hunk is the whole file
			if (s.base === null || s.current === null) { return; }
			// on a conflict this is "Use agent's": the agent's version replaces the user's overlapping region
			const { base, current } = acceptHunkText(state, s.base, s.current);
			if (!await this._writeUser(this._userUri(agent, s.file.path), s.current, current)) { return; }
			await this._worktree.writeBase(agent.agentId, s.file.path, base);
		});
	}

	rejectHunk(threadId: string, path: string, rendered: HunkState): Promise<void> {
		return this._write(threadId, path, async s => {
			const state = this._freshHunk(s.review, rendered);
			if (!state || s.file.binary) { return; }
			if (s.review.kind !== 'modified') { return this._rejectWhole(s, false); }
			if (s.agentText === null) { return; }
			// on a conflict this is "Keep mine": the agent's change is reverted, the user's text stays
			await this._writeWorktree(s.agent, s.file.path, rejectHunkText(state.hunk, s.agentText));
		});
	}

	acceptFile(threadId: string, path: string): Promise<void> {
		return this._write(threadId, path, async s => {
			// a file-level conflict blocks this (FILE_CONFLICT_ACCEPT_TOOLTIP); a modified file's hunk conflicts stay pending,
			// each needs "Keep mine" or "Use agent's"
			return this._acceptWhole(s);
		});
	}

	rejectFile(threadId: string, path: string): Promise<void> {
		return this._write(threadId, path, s => this._rejectWhole(s, false));
	}

	acceptAll(threadId: string): Promise<void> {
		return this._enqueue(threadId, async () => {
			const agent = this._agentOf(threadId);
			if (!agent) { return; }
			for (const { file } of await this._pendingFiles(agent)) {
				const s = await this._fileState(agent, file.path); // fresh, right before merging this file
				if (s) { await this._acceptWhole(s); }
			}
			await this._refresh(threadId, true);
		});
	}

	rejectAll(threadId: string): Promise<void> {
		return this._enqueue(threadId, async () => {
			const agent = this._agentOf(threadId);
			if (!agent) { return; }
			for (const { file } of await this._pendingFiles(agent)) {
				const s = await this._fileState(agent, file.path); // fresh, right before this file
				if (s) { await this._rejectWhole(s, true); }
			}
			await this._refresh(threadId, true);
		});
	}
}

registerSingleton(IBackgroundAgentsService, BackgroundAgentsService, InstantiationType.Delayed);

/** Creates the service at startup so leftover worktrees are pruned and persisted agents get their counts. */
class BackgroundAgentsStartup implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zeroEgressBackgroundAgents';
	constructor(@IBackgroundAgentsService backgroundAgentsService: IBackgroundAgentsService) {
		void backgroundAgentsService.agents;
	}
}
registerWorkbenchContribution2(BackgroundAgentsStartup.ID, BackgroundAgentsStartup, WorkbenchPhase.Eventually);
