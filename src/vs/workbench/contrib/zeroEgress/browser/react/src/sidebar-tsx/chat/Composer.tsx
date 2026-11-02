/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// A chat's input box. Top to bottom: the review bar (docked only, joined to the box as one card), the context chips,
// the text area (@ mentions a file), then a row with the mode and model menus, a slot for the context meter, ⚙ and
// Send/Stop. ⏎ sends; ⌘⏎ with an empty box accepts this chat's changes only; Escape stops a running chat.
// "Run in: Background" on an empty docked chat makes Send start a background agent with the prompt instead.
// A / command (the menu opens on a lone "/word") expands to its prompt before anything is sent; in the background
// path that prompt and its staged context are what the agent gets (modes do not apply there, and /compact does nothing).

import React, { KeyboardEvent, useCallback, useEffect, useState } from 'react';
import { useAccessor, useActiveURI, useChatThreadsState, useChatThreadsStreamState, useSettingsState } from '../../util/services.js';
import { TextAreaFns, ZeroEgressInputBox2 } from '../../util/inputs.js';
import { ButtonStop, ButtonSubmit, getRelative, SelectedFiles } from '../SidebarChat.js';
// no runtime imports from vs/ here: the bundle flattens this folder, so a relative path one level deeper breaks
import { builtinCommands, isFeatureNameDisabled, promptContextOfSelection, resolveSlashSend, slashEnterPicks, slashMenuQuery, withNewSelections, promptWithContext, ZERO_EGRESS_CTRL_L_ACTION_ID, ZERO_EGRESS_SHOW_AGENTS_ACTION_ID } from '../composerDeps.js';
import type { ChatMode, CustomCommand, PromptContextItem } from '../composerDeps.js';
import type { StagingSelectionItem } from '../../../../../common/chatThreadServiceTypes.js';
import { useThreadReview } from '../useThreadReview.js';
import { AgentSettingsMenu } from './AgentSettingsMenu.js';
import { ContextMeter } from './ContextMeter.js';
import { ModeMenu, RunIn, RunInSection } from './ModeMenu.js';
import { ModelMenu } from './ModelMenu.js';
import { ReviewBar } from './ReviewBar.js';
import { gatherSlashContext } from './slashContext.js';
import { flattenSlashSections, SlashItem, SlashMenu, SlashSection } from './SlashMenu.js';

/** what the chat view around the box needs from it: the suggestions on an empty chat send through it */
export interface ComposerApi {
	submit(text?: string): void;
}

export const Composer = ({ threadId, variant, inputDisabledReason, textAreaRef, apiRef }: {
	threadId: string;
	variant: 'docked' | 'agents';
	/** shown instead of the box (e.g. a background agent whose worktree was removed takes no follow-ups) */
	inputDisabledReason?: string;
	/** the text area, for the chat's mount info (focus, ⌘L) */
	textAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
	apiRef?: React.MutableRefObject<ComposerApi | null>;
}) => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const chatThreadsService = accessor.get('IChatThreadService');
	const settingsState = useSettingsState();
	const settingsService = accessor.get('IZeroEgressSettingsService');
	const contextService = accessor.get('IChatContextService');
	const languageService = accessor.get('ILanguageService');
	const { uri: activeUri } = useActiveURI();

	const thread = useChatThreadsState().allThreads[threadId];
	const messages = thread?.messages ?? [];
	const isAgentThread = variant === 'agents' || !!thread?.agent;
	const hasUserMessage = messages.some(m => m.role === 'user');
	const selections = thread?.state.stagingSelections ?? [];
	const setSelections = useCallback((s: StagingSelectionItem[]) => { chatThreadsService.setCurrentThreadState({ stagingSelections: s }, threadId); }, [chatThreadsService, threadId]);

	const isRunning = useChatThreadsStreamState(threadId)?.isRunning;

	const textAreaFnsRef = React.useRef<TextAreaFns | null>(null);
	const [instructionsAreEmpty, setInstructionsAreEmpty] = useState(true);
	const isDisabled = instructionsAreEmpty || !!isFeatureNameDisabled('Chat', settingsState);

	// ⌘⏎ with an empty input accepts this chat's pending changes (edits, creates, deletes), never another chat's
	const review = useThreadReview(threadId);
	const hasPendingChanges = variant === 'docked' && review.mine.length > 0; // the Agents view has its own review column

	// ----- Run in (docked panel only) -----
	const [bgAvailability, setBgAvailability] = useState<{ ok: true } | { ok: false; reason: string } | null>(null);
	const [isMoving, setIsMoving] = useState(false);
	const [runIn, setRunIn] = useState<RunIn>('folder');
	useEffect(() => {
		if (variant !== 'docked') { return; }
		let cancelled = false;
		accessor.get('IBackgroundAgentsService').availability().then(a => { if (!cancelled) { setBgAvailability(a); } }).catch(() => { });
		return () => { cancelled = true; };
	}, [variant, accessor]);
	const startsInBackground = variant === 'docked' && !hasUserMessage && runIn === 'background' && !!bgAvailability?.ok;

	const moveDisabledReason: string | null = (
		isRunning ? 'Stop the agent first.'
			: !hasUserMessage ? 'Nothing to move yet.'
				: review.mine.length > 0 ? `Accept or reject this agent's pending changes first.`
					: bgAvailability && !bgAvailability.ok ? bgAvailability.reason
						: !bgAvailability ? 'Checking whether background agents are available.'
							: null
	);
	const moveToBackground = async () => {
		if (moveDisabledReason || isMoving) { return; }
		setIsMoving(true);
		try {
			await accessor.get('IBackgroundAgentsService').startAgent('', threadId);
			chatThreadsService.openNewThread();
			await commandService.executeCommand(ZERO_EGRESS_SHOW_AGENTS_ACTION_ID);
		} catch (e) {
			accessor.get('INotificationService').error(e instanceof Error ? e.message : String(e));
		} finally {
			setIsMoving(false);
		}
	};
	const bgUnavailableReason = !bgAvailability ? 'Checking whether background agents are available.'
		: !bgAvailability.ok ? bgAvailability.reason
			: null;
	const runInSection: RunInSection | undefined = variant === 'docked' ? {
		unavailableReason: bgUnavailableReason,
		isEmptyChat: !hasUserMessage,
		value: runIn,
		onChange: setRunIn,
		moveDisabledReason,
		isMoving,
		onMove: () => { moveToBackground(); },
	} : undefined;

	// ----- send -----
	const [isStarting, setIsStarting] = useState(false);
	const clearInput = () => {
		setSelections([]); // clear staging
		textAreaFnsRef.current?.setValue('');
		textAreaRef.current?.focus(); // focus input after submit
	};
	const loadingCustomRef = React.useRef(false);
	const customRef = React.useRef<CustomCommand[] | null>(null); // null: not loaded yet
	const [custom, setCustom] = useState<CustomCommand[]>([]);
	const onSubmit = async (_forceSubmit?: string) => {
		if ((isDisabled && !_forceSubmit) || isFeatureNameDisabled('Chat', settingsState)) { return; }
		if (isRunning || isStarting || loadingCustomRef.current) { return; }
		const userMessage0 = _forceSubmit || textAreaRef.current?.value || '';

		let userMessage = userMessage0;

		// ----- / commands -----
		// project commands: the list the menu loaded, or one load when the user typed a whole command without opening it
		if (customRef.current === null && userMessage.trimStart().startsWith('/')) {
			loadingCustomRef.current = true; // blocks a second Enter while the list loads
			setIsStarting(true);
			try { customRef.current = await contextService.customCommands().catch(() => []); } finally { loadingCustomRef.current = false; setIsStarting(false); }
		}
		const send = resolveSlashSend(userMessage, { hasSelection: !!contextService.currentSelection() }, customRef.current ?? []);
		let sendSelections = selections;
		if (send.isCommand) {
			// /plan and /compact act on the side panel chat's own mode and history, not on an agent's
			if ((send.compact || send.setMode) && (startsInBackground || isAgentThread)) {
				accessor.get('INotificationService').info('/plan and /compact work in the side panel chat.');
				return; // the box keeps what was typed
			}
			if (send.compact) {
				await chatThreadsService.compactThread(threadId);
				clearInput();
				return;
			}
			if (send.setMode) {
				await settingsService.setGlobalSetting('chatMode', send.setMode);
				if (!send.prompt) { clearInput(); return; }
			}
			if (send.addContext?.length) {
				const added = await gatherSlashContext(send.addContext, {
					contextService, activeUri, languageOf: uri => languageService.guessLanguageIdByFilepathOrFirstLine(uri) || '',
					notify: m => accessor.get('INotificationService').info(m),
				});
				if (!added) { return; }
				sendSelections = withNewSelections(selections, added);
				setSelections(sendSelections);
			}
		}
		const displayMessage = send.displayMessage;
		const modeOverride = send.modeOverride;
		userMessage = send.prompt;

		if (startsInBackground) {
			const prompt = userMessage.trim();
			if (!prompt) { return; }
			// the agent's first message is plain text: the staged chips go into it as workspace-relative paths
			// terminal output, problems and git diffs go in as text; images are not sent to background agents yet
			if (sendSelections.some(sel => sel.type === 'Image')) {
				accessor.get('INotificationService').info("Images aren't sent to background agents yet.");
			}
			const context: PromptContextItem[] = sendSelections.flatMap((sel): PromptContextItem[] => {
				const item = promptContextOfSelection(sel, uri => {
					// getRelative gives back the fsPath itself for a file outside the workspace: that one stays absolute
					const relative = getRelative(uri as Parameters<typeof getRelative>[0], accessor);
					const absolute = relative === undefined || relative === uri.fsPath;
					return { path: absolute ? uri.fsPath : relative, absolute };
				});
				return item ? [item] : [];
			});
			setIsStarting(true);
			try {
				await accessor.get('IBackgroundAgentsService').startAgent(promptWithContext(prompt, context), undefined, { displayMessage, modeOverride });
				clearInput();
				setRunIn('folder');
				await commandService.executeCommand(ZERO_EGRESS_SHOW_AGENTS_ACTION_ID);
			} catch (e) {
				accessor.get('INotificationService').error(e instanceof Error ? e.message : String(e));
			} finally {
				setIsStarting(false);
			}
			return;
		}

		try {
			await chatThreadsService.addUserMessageAndStreamResponse({ userMessage, threadId, displayMessage, modeOverride });
		} catch (e) {
			console.error('Error while sending message in chat:', e);
		}
		clearInput();
	};
	const onAbort = async () => {
		await chatThreadsService.abortRunning(threadId);
	};
	if (apiRef) {
		apiRef.current = { submit: text => { onSubmit(text); } };
	}

	// ----- the / menu -----
	const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
	const [typed, setTyped] = useState('');
	const [slashIdx, setSlashIdx] = useState(0);
	const [slashClosed, setSlashClosed] = useState(false);
	const slashMovedRef = React.useRef(false); // the arrow keys moved the highlight since the text last changed
	const slashPickedRef = React.useRef(false); // a pick rewrites the text itself: that change must not reopen the menu
	const onChangeText = useCallback((newStr: string) => {
		setInstructionsAreEmpty(!newStr);
		setTyped(newStr);
		setSlashIdx(0);
		slashMovedRef.current = false;
		setSlashClosed(slashPickedRef.current);
	}, []);
	const slashQuery = slashMenuQuery(typed);
	// the project's commands load each time the menu opens (cached while it is open)
	const slashIsOpen = slashQuery !== null;
	useEffect(() => {
		if (!slashIsOpen) { return; }
		let live = true;
		void contextService.customCommands().catch(() => []).then(list => { if (live) { customRef.current = list; setCustom(list); } });
		return () => { live = false; };
	}, [slashIsOpen, contextService]);
	const builtinNames = new Set(builtinCommands.map(c => c.name));
	const slashSections: SlashSection[] = [{
		heading: 'Commands',
		items: slashQuery === null ? [] : builtinCommands.filter(c => c.name.startsWith(slashQuery)),
	}, {
		heading: 'Yours',
		items: slashQuery === null ? [] : custom.filter(c => !builtinNames.has(c.name) && c.name.startsWith(slashQuery))
			.map(c => ({ name: c.name, detail: '.zeroegress/commands', title: c.description })),
	}];
	const slashItems = flattenSlashSections(slashSections);
	const slashOpen = !slashClosed && slashQuery !== null && slashItems.length > 0 && !inputDisabledReason;
	const runSlashItem = (item: SlashItem) => {
		if (isFeatureNameDisabled('Chat', settingsState)) { return; }
		slashPickedRef.current = true;
		setSlashClosed(true);
		textAreaFnsRef.current?.setValue('/' + item.name);
		slashPickedRef.current = false;
		void onSubmit('/' + item.name);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (slashOpen && !e.nativeEvent.isComposing) {
			const active = slashItems[Math.min(slashIdx, slashItems.length - 1)];
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				slashMovedRef.current = true;
				setSlashIdx(i => (i + (e.key === 'ArrowDown' ? 1 : slashItems.length - 1)) % slashItems.length);
				return;
			} else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
				e.preventDefault();
				if (slashEnterPicks(slashQuery ?? '', slashMovedRef.current)) { runSlashItem(active); }
				return; // a bare "/": nothing runs and the menu stays open
			} else if (e.key === 'Tab' && !e.shiftKey) {
				e.preventDefault();
				textAreaFnsRef.current?.setValue('/' + active.name + ' ');
				return;
			} else if (e.key === 'Escape') {
				e.preventDefault();
				setSlashClosed(true);
				return;
			}
		}
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && instructionsAreEmpty && hasPendingChanges) {
			e.preventDefault();
			review.acceptOrRejectMine('accept');
		} else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			onSubmit();
		} else if (e.key === 'Escape' && isRunning) {
			onAbort();
		}
	};

	// image files on the clipboard become image chips; any other paste is left alone
	const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const images = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'));
		if (!images.length) return;
		e.preventDefault();
		// text that came with the images still goes in at the cursor
		const text = e.clipboardData.getData('text/plain');
		const ta = textAreaRef.current;
		if (text && ta) {
			const start = ta.selectionStart, end = ta.selectionEnd;
			textAreaFnsRef.current?.setValue(ta.value.slice(0, start) + text + ta.value.slice(end));
			ta.setSelectionRange(start + text.length, start + text.length);
		}
		const contextService = accessor.get('IChatContextService');
		void (async () => {
			for (const file of images) {
				try {
					const sel = await contextService.imageFromClipboard(new Uint8Array(await file.arrayBuffer()), file.type);
					if (sel) chatThreadsService.addNewStagingSelection(sel);
				} catch (err) {
					accessor.get('INotificationService').error(err instanceof Error ? err.message : String(err));
				}
			}
		})();
	};

	const keybindingString = accessor.get('IKeybindingService').lookupKeybinding(ZERO_EGRESS_CTRL_L_ACTION_ID)?.getLabel();
	const showReviewBar = variant === 'docked' && review.mine.length > 0;

	const reviewBar = variant === 'docked' ? <ReviewBar threadId={threadId} review={review} /> : null;
	if (inputDisabledReason) {
		return <div>
			{reviewBar}
			<div className='px-2 py-2 text-sm text-ze-fg-3 select-none'>{inputDisabledReason}</div>
		</div>;
	}

	return <div>
		{reviewBar}
		<div
			ref={setCardEl}
			className={`flex flex-col gap-1 p-2 relative input text-left shrink-0 bg-ze-bg-2 transition-colors duration-200
				border border-ze-border-2 focus-within:border-ze-accent hover:border-ze-border-1
				max-h-[80vh] overflow-y-auto
				${showReviewBar ? 'rounded-b-[10px]' : 'rounded-[10px]'}`}
			onClick={() => { textAreaRef.current?.focus(); }}
		>
			{/* 1. context chips */}
			<SelectedFiles type='staging' selections={selections} setSelections={setSelections} />

			{/* 2. the text area */}
			<div className='relative w-full'>
				<ZeroEgressInputBox2
					enableAtToMention
					className='min-h-[81px] px-0.5 py-0.5'
					placeholder={`Ask, or @ a file…${keybindingString ? ` (${keybindingString} adds the selection)` : ''}`}
					onChangeText={onChangeText}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					onFocus={() => { chatThreadsService.setCurrentlyFocusedMessageIdx(undefined, threadId); }}
					ref={textAreaRef}
					fnsRef={textAreaFnsRef}
					multiline={true}
				/>
			</div>

			<SlashMenu
				anchor={cardEl}
				open={slashOpen}
				sections={slashSections}
				activeIdx={slashIdx}
				onPick={runSlashItem}
				onClose={() => setSlashClosed(true)}
			/>

			{/* 3. mode, model, meter slot, ⚙, send */}
			{/* a narrow panel wraps the right-hand group onto its own line rather than clipping it */}
			<div className='flex flex-row flex-wrap items-center justify-between gap-x-1 gap-y-1 min-w-0'>
				<div className='flex items-center gap-1 min-w-0'>
					{variant === 'agents'
						// background agents always run in agent mode; the mode menu sets the docked chats'
						? <span className='text-xs text-ze-fg-3 px-1.5 select-none' data-fixed-mode>Agent</span>
						: <ModeMenu variant={variant} runIn={runInSection} />}
					<ModelMenu featureName='Chat' />
				</div>
				<div className='flex items-center gap-1 shrink-0 ml-auto'>
					<ContextMeter threadId={threadId} />
					<AgentSettingsMenu threadId={threadId} />
					{isRunning
						? <ButtonStop onClick={onAbort} aria-label='Stop' />
						: startsInBackground
							? <button
								type='button'
								disabled={isDisabled || isStarting}
								className={`h-[22px] px-2 rounded-full text-xs font-medium whitespace-nowrap
									${isDisabled || isStarting ? 'bg-vscode-disabled-fg text-ze-bg-2 cursor-default' : 'bg-ze-accent text-ze-on-accent hover:bg-ze-accent-hover cursor-pointer'}`}
								onClick={e => { e.stopPropagation(); onSubmit(); }}
							>{isStarting ? 'Starting…' : 'Start in background'}</button>
							: <ButtonSubmit onClick={() => onSubmit()} disabled={isDisabled} aria-label='Send' />}
				</div>
			</div>
		</div>
	</div>;
};
