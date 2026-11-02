/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { basename, extUri, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { symbolKindNames } from '../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IZeroEgressModelService } from '../common/zeroEgressModelService.js';
import { checkProjectRulesFile, PROJECT_RULES_FILE } from './projectRules.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { ISCMService } from '../../scm/common/scm.js';
import { getWorkspaceSymbols } from '../../search/common/search.js';
import { COMMAND_FILE_MAX_BYTES, COMMAND_FILES_MAX, CustomCommand, isLoadableCommandEntry, parseCommandFile } from '../common/slashCommands.js';
import { StagingSelectionItem } from '../common/chatThreadServiceTypes.js';
import { DIFF_MAX_CHARS, IMAGE_MAX_BYTES, PROBLEMS_MAX, SavedDoc, TERMINAL_MAX_CHARS, capHead, capTail, imageExtOf, isValidBranchName } from '../common/selectionText.js';
import { IZeroEgressSCMService } from '../common/zeroEgressSCMTypes.js';
import { roundRangeToLines } from './sidebarActions.js';
import { readXtermBuffer } from './terminalToolService.js';

type Sel<T extends StagingSelectionItem['type']> = StagingSelectionItem & { type: T };

const SAVED_DOCS_KEY = 'zeroEgress.savedDocs';
const MAX_SYMBOLS = 50;
const XTERM_FALLBACK_CHARS = 4000;
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const MIME_OF_EXT = new Map<string, Sel<'Image'>['mime']>([
	['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'],
]);
const SYMBOL_TIMEOUT_MS = 2000;
const COMMANDS_DIR = '.zeroegress/commands';
const COMMANDS_MAX_FILES = COMMAND_FILES_MAX;
const COMMANDS_MAX_BYTES = COMMAND_FILE_MAX_BYTES;
const PROJECT_RULES_HEADER = '# Rules for the agent in this project. Plain text; the agent reads this file with every message.\n';
const PROJECT_RULES_LINK = ".zeroegressrules is a link, so ZeroEgress won't read it.";
const UNSUPPORTED_IMAGE = 'Only PNG, JPEG, WebP and GIF images are supported.';

export interface IChatContextService {
	readonly _serviceBrand: undefined;
	searchSymbols(query: string): Promise<Sel<'Symbol'>[]>;
	currentSelection(): Sel<'CodeSelection'> | null;
	terminalSnapshot(): Promise<Sel<'Terminal'> | null>;
	filesWithProblems(): { uri: URI; count: number }[];
	problems(uri?: URI): Sel<'Problems'>;
	gitBranches(): Promise<string[]>;
	gitDiff(against: string | null): Promise<Sel<'GitDiff'> | null>;
	savedDocs(): SavedDoc[];
	addSavedDoc(): Promise<SavedDoc | null>;
	removeSavedDoc(path: string): void;
	pickImage(): Promise<Sel<'Image'> | null>;
	imageFromClipboard(data: Uint8Array, mime: string): Promise<Sel<'Image'> | null>;
	customCommands(): Promise<CustomCommand[]>;
	hasWorkspaceFolder(): boolean;
	/** opens <first folder>/.zeroegressrules, creating it with a header line if missing; never through a symlink */
	openProjectRules(): Promise<void>;
}

export const IChatContextService = createDecorator<IChatContextService>('zeroEgressChatContextService');

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

class ChatContextService implements IChatContextService {
	declare readonly _serviceBrand: undefined;

	private readonly scm: IZeroEgressSCMService;

	constructor(
		@ICodeEditorService private readonly editorService: ICodeEditorService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IMarkerService private readonly markerService: IMarkerService,
		@ISCMService private readonly scmService: ISCMService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IZeroEgressModelService private readonly zeroEgressModelService: IZeroEgressModelService,
	) {
		this.scm = ProxyChannel.toService<IZeroEgressSCMService>(mainProcessService.getChannel('zero-egress-channel-scm'));
	}

	private symbolSearch: CancellationTokenSource | undefined;

	async searchSymbols(query: string): Promise<Sel<'Symbol'>[]> {
		// a new query cancels the previous in-flight one
		this.symbolSearch?.cancel();
		this.symbolSearch?.dispose();
		const cts = this.symbolSearch = new CancellationTokenSource();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<null>(resolve => {
			timer = setTimeout(() => { cts.cancel(); resolve(null); }, SYMBOL_TIMEOUT_MS);
		});
		try {
			const items = await Promise.race([getWorkspaceSymbols(query, cts.token).catch(() => null), timedOut]);
			if (!items || cts.token.isCancellationRequested) { return []; }
			return items.slice(0, MAX_SYMBOLS).map(({ symbol }) => ({
				type: 'Symbol' as const,
				uri: symbol.location.uri,
				range: [symbol.location.range.startLineNumber, symbol.location.range.endLineNumber] as [number, number],
				name: symbol.name,
				kind: symbolKindNames[symbol.kind] ?? 'unknown',
				language: this.languageService.guessLanguageIdByFilepathOrFirstLine(symbol.location.uri) || '',
			}));
		} finally {
			clearTimeout(timer);
			if (this.symbolSearch === cts) { this.symbolSearch = undefined; }
			cts.dispose();
		}
	}

	currentSelection(): Sel<'CodeSelection'> | null {
		const editor = this.editorService.getActiveCodeEditor();
		const model = editor?.getModel();
		if (!editor || !model) { return null; }
		const range = roundRangeToLines(editor.getSelection(), { emptySelectionBehavior: 'null' });
		if (!range) { return null; }
		return {
			type: 'CodeSelection',
			uri: model.uri,
			language: model.getLanguageId(),
			range: [range.startLineNumber, range.endLineNumber],
			state: { wasAddedAsCurrentFile: false },
		};
	}

	async terminalSnapshot(): Promise<Sel<'Terminal'> | null> {
		const instance = this.terminalService.activeInstance;
		if (!instance) { return null; }
		let text: string | undefined;
		const cmdCap = instance.capabilities.get(TerminalCapability.CommandDetection);
		if (cmdCap) {
			const last = cmdCap.commands[cmdCap.commands.length - 1];
			text = last?.getOutput();
		}
		if (!text) {
			text = capTail(readXtermBuffer(instance), XTERM_FALLBACK_CHARS);
		}
		if (!text.trim()) { return null; }
		return {
			type: 'Terminal',
			title: instance.title || 'Terminal',
			text: capTail(text, TERMINAL_MAX_CHARS),
			capturedAt: new Date().toISOString(),
		};
	}

	filesWithProblems(): { uri: URI; count: number }[] {
		const counts = new Map<string, { uri: URI; count: number }>();
		for (const m of this.markerService.read()) {
			if (m.severity !== MarkerSeverity.Error && m.severity !== MarkerSeverity.Warning) { continue; }
			const key = m.resource.toString();
			const entry = counts.get(key);
			if (entry) { entry.count++; } else { counts.set(key, { uri: m.resource, count: 1 }); }
		}
		return [...counts.values()].sort((a, b) => b.count - a.count);
	}

	problems(uri?: URI): Sel<'Problems'> {
		const markers = this.markerService.read(uri ? { resource: uri } : undefined)
			.filter(m => m.severity === MarkerSeverity.Error || m.severity === MarkerSeverity.Warning)
			.sort((a, b) => b.severity - a.severity) // errors before warnings
			.slice(0, PROBLEMS_MAX);
		return {
			type: 'Problems',
			uri,
			items: markers.map(m => ({
				path: m.resource.fsPath,
				line: m.startLineNumber,
				severity: m.severity === MarkerSeverity.Error ? 'error' as const : 'warning' as const,
				message: m.message,
			})),
		};
	}

	private gitRepoPath(): string | null {
		const repo = Array.from(this.scmService.repositories || []).find(r => r.provider.contextValue === 'git');
		return repo?.provider.rootUri?.fsPath ?? null;
	}

	async gitBranches(): Promise<string[]> {
		const path = this.gitRepoPath();
		if (!path) { return []; }
		return (await this.scm.gitBranches(path)).filter(isValidBranchName);
	}

	async gitDiff(against: string | null): Promise<Sel<'GitDiff'> | null> {
		if (against !== null && !isValidBranchName(against)) { throw new Error('Not a valid branch name.'); }
		const path = this.gitRepoPath();
		if (!path) { return null; }
		try {
			const { text, truncated } = await this.scm.gitDiff(path, against);
			return { type: 'GitDiff', against, text: capHead(text, DIFF_MAX_CHARS), truncated };
		} catch (e) {
			const first = (e instanceof Error ? e.message : String(e)).trim().split('\n')[0];
			this.notificationService.notify({ severity: Severity.Warning, message: `Couldn't read the git diff: ${first}` });
			return null;
		}
	}

	savedDocs(): SavedDoc[] {
		try {
			const parsed = JSON.parse(this.storageService.get(SAVED_DOCS_KEY, StorageScope.APPLICATION, '[]'));
			if (!Array.isArray(parsed)) { return []; }
			return parsed.filter((d): d is SavedDoc => !!d && typeof d.name === 'string' && typeof d.path === 'string' && typeof d.isFolder === 'boolean');
		} catch {
			return [];
		}
	}

	private storeSavedDocs(docs: SavedDoc[]) {
		this.storageService.store(SAVED_DOCS_KEY, JSON.stringify(docs), StorageScope.APPLICATION, StorageTarget.USER);
	}

	async addSavedDoc(): Promise<SavedDoc | null> {
		const picked = await this.fileDialogService.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: false });
		const uri = picked?.[0];
		if (!uri || uri.scheme !== 'file') { return null; }
		const stat = await this.fileService.stat(uri);
		const doc: SavedDoc = { name: basename(uri), path: uri.fsPath, isFolder: stat.isDirectory };
		this.storeSavedDocs([...this.savedDocs().filter(d => d.path !== doc.path), doc]);
		return doc;
	}

	removeSavedDoc(path: string): void {
		this.storeSavedDocs(this.savedDocs().filter(d => d.path !== path));
	}

	private tooBig() {
		this.notificationService.notify({ severity: Severity.Warning, message: 'Images must be 5 MB or smaller.' });
		return null;
	}

	async pickImage(): Promise<Sel<'Image'> | null> {
		const picked = await this.fileDialogService.showOpenDialog({
			canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
			filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }],
		});
		const uri = picked?.[0];
		if (!uri) { return null; }
		const ext = uri.path.slice(uri.path.lastIndexOf('.') + 1).toLowerCase();
		const mime = MIME_OF_EXT.get(ext);
		if (!mime) { this.notificationService.notify({ severity: Severity.Warning, message: UNSUPPORTED_IMAGE }); return null; }
		const stat = await this.fileService.stat(uri);
		if (stat.size > IMAGE_MAX_BYTES) { return this.tooBig(); }
		return { type: 'Image', uri, name: basename(uri), mime, bytes: stat.size };
	}

	async imageFromClipboard(data: Uint8Array, mime: string): Promise<Sel<'Image'> | null> {
		const ext = imageExtOf(mime);
		if (!ext) { this.notificationService.notify({ severity: Severity.Warning, message: UNSUPPORTED_IMAGE }); return null; }
		if (data.byteLength > IMAGE_MAX_BYTES) { return this.tooBig(); }
		// SHA-256 via crypto.subtle (same browser-safe hash base/browser/iframe.ts uses)
		const hash = toHex(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
		const name = `${hash}.${ext}`;
		const uri = joinPath(this.environmentService.userRoamingDataHome, 'zeroEgress', 'pasted-images', name);
		if (!(await this.fileService.exists(uri))) {
			await this.fileService.writeFile(uri, VSBuffer.wrap(data));
		}
		return { type: 'Image', uri, name, mime: mime as Sel<'Image'>['mime'], bytes: data.byteLength };
	}

	hasWorkspaceFolder(): boolean {
		return this.workspaceService.getWorkspace().folders.length > 0;
	}

	async openProjectRules(): Promise<void> {
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder) { return; }
		const uri = joinPath(folder.uri, PROJECT_RULES_FILE);
		let state = await checkProjectRulesFile(this.fileService, uri);
		if (state === 'missing') {
			await this.fileService.writeFile(uri, VSBuffer.fromString(PROJECT_RULES_HEADER));
			state = await checkProjectRulesFile(this.fileService, uri);
		}
		if (state !== 'ok') {
			this.notificationService.notify({ severity: Severity.Warning, message: PROJECT_RULES_LINK });
			return;
		}
		// so new rules apply without a reload
		await this.zeroEgressModelService.initializeModel(uri);
		await this.commandService.executeCommand('vscode.open', uri);
	}

	/** <folder>/.zeroegress/commands/*.md of each workspace folder in order; the first of a name wins. Prompt text only; symlinks are never followed. */
	async customCommands(): Promise<CustomCommand[]> {
		const found = new Map<string, CustomCommand>();
		for (const folder of this.workspaceService.getWorkspace().folders) {
			if (found.size >= COMMANDS_MAX_FILES) { break; }
			try {
				const root = joinPath(folder.uri, '.zeroegress');
				const rootStat = await this.fileService.resolve(root, { resolveMetadata: true });
				if (rootStat.isSymbolicLink || !rootStat.isDirectory) { continue; }
				const commandsDir = joinPath(root, 'commands');
				const dir = await this.fileService.resolve(commandsDir, { resolveMetadata: true });
				if (dir.isSymbolicLink || !dir.isDirectory) { continue; }
				const files = (dir.children ?? []).filter(c => isLoadableCommandEntry({
					name: c.name, isFile: c.isFile, isSymbolicLink: c.isSymbolicLink, size: c.size,
					parentIsCommandsDir: extUri.isEqual(extUri.dirname(c.resource), commandsDir),
				})).sort((a, b) => a.name.localeCompare(b.name));
				for (const f of files) {
					if (found.size >= COMMANDS_MAX_FILES) { break; }
					try {
						const buf = (await this.fileService.readFile(f.resource, { limits: { size: COMMANDS_MAX_BYTES } })).value;
						if (buf.byteLength > COMMANDS_MAX_BYTES) { continue; }
						const cmd = parseCommandFile(f.name, buf.toString(), COMMANDS_DIR + '/' + f.name);
						if (cmd && !found.has(cmd.name)) { found.set(cmd.name, cmd); }
					} catch { /* an unreadable file is skipped */ }
				}
			} catch { /* no commands folder in this workspace folder */ }
		}
		return [...found.values()];
	}
}

registerSingleton(IChatContextService, ChatContextService, InstantiationType.Delayed);
