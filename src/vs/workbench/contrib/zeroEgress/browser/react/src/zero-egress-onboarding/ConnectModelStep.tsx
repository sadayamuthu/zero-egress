/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// First run, step 2: finds model servers at the loopback default ports (and at URLs the user adds), lists what
// each one answered, and recommends a model. Continue fills in settings through ILocalModelDetectionService.apply,
// which never changes an endpoint or a model choice the user already made.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { FoundModel, isLoopbackUrl, PROBE_TARGETS, recommendModel } from '../../../../common/localDetection.js';
import { oneResultPerProvider, ProbeResult, withProvider } from '../../../localModelDetectionService.js';
import { displayInfoOfProviderName, ProviderName } from '../../../../common/zeroEgressSettingsTypes.js';
import { endpointWarning, targetFromUrl } from '../../../../common/egressPolicy.js';
import { localStatusOf } from '../../../../common/localStatus.js';

const OLLAMA_PULL_HINT = 'Pull a model first, for example: ollama pull qwen2.5-coder:7b';

/** The Add URL provider choices, in this order. */
const ADD_URL_PROVIDERS: readonly ProviderName[] = ['vLLM', 'lmStudio', 'ollama', 'oMLX'];

/** One row of the list: a default port, or a URL the user added. `result` is null while it is being probed. */
interface Row {
	key: string;
	url: string;
	/** For an added URL, the provider the user picked; for a default port, its provider (or null for port 8000). */
	provider: ProviderName | null;
	isCustom: boolean;
	result: ProbeResult | null;
}

const defaultRows = (): Row[] => PROBE_TARGETS.map(t => ({
	key: t.id,
	url: t.url,
	provider: t.id === 'port8000' ? null : t.providers[0],
	isCustom: false,
	result: null,
}));

/** `host:port` of a URL, without the scheme. */
const hostPortOf = (url: string): string => {
	try { return new URL(url).host; } catch { return url; }
};

/** An http(s) URL the probe can use, or null. */
const parsedHttpUrl = (typed: string): string | null => {
	const trimmed = typed.trim();
	try {
		const { protocol } = new URL(trimmed);
		return protocol === 'http:' || protocol === 'https:' ? trimmed : null;
	} catch {
		return null;
	}
};

/** The LAN / Internet wording the rest of the app uses for a destination that is not this machine. */
const networkNoteOf = (url: string): string | undefined => {
	if (isLoopbackUrl(url)) { return undefined; }
	const internet = endpointWarning(url);
	if (internet) { return internet; }
	const target = targetFromUrl(url);
	const status = target ? localStatusOf([target]) : undefined;
	// Same wording as the LAN status bar tooltip (common/localStatus.ts).
	return status?.kind === 'lan' ? `Connects to your network: ${status.hosts.join(', ')}` : undefined;
};

const modelKey = (m: FoundModel) => `${m.providerName}\u0000${m.modelName}`;

const providerTitle = (p: ProviderName) => displayInfoOfProviderName(p).title;

export type ConnectModelState = ReturnType<typeof useConnectModel>;

/**
 * Step 2's state. It lives in the first-run component rather than the step, so a URL the user added survives
 * Back. Each time the step becomes active the default ports are probed again.
 */
export const useConnectModel = (active: boolean) => {
	const accessor = useAccessor();
	const detection = accessor.get('ILocalModelDetectionService');

	const [rows, setRows] = useState<Row[]>(defaultRows);
	/** What the user said an unknown port 8000 server is. */
	const [port8000Pick, setPort8000Pick] = useState<ProviderName | null>(null);
	/** undefined: follow the recommendation. */
	const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);

	const scanGeneration = useRef(0);
	const isMounted = useRef(true);
	useEffect(() => () => { isMounted.current = false; }, []);

	const rescan = useCallback(() => {
		const generation = ++scanGeneration.current;
		setRows(rs => rs.map(r => r.isCustom ? r : { ...r, result: null }));
		void detection.detect().then(results => {
			if (!isMounted.current || generation !== scanGeneration.current) { return; }
			setRows(rs => rs.map(r => {
				if (r.isCustom) { return r; }
				const result = results.find(x => x.target.id === r.key);
				return result ? { ...r, result } : { ...r, result: { target: { id: 'custom', url: r.url, providers: [] }, status: 'not_running', providerName: null, models: [] } };
			}));
		});
	}, [detection]);

	useEffect(() => {
		if (active) { rescan(); }
	}, [active, rescan]);

	const customCount = useRef(0);
	/** Probes a typed URL. Returns false (and adds nothing) when it is not an http(s) URL. */
	const addUrl = useCallback((typed: string, provider: ProviderName): boolean => {
		const url = parsedHttpUrl(typed);
		if (url === null) { return false; }
		const key = `custom-${++customCount.current}`;
		setRows(rs => [...rs, { key, url, provider, isCustom: true, result: null }]);
		void detection.probeUrl(url, provider).then(result => {
			if (!isMounted.current) { return; }
			setRows(rs => rs.map(r => r.key === key ? { ...r, result } : r));
		});
		return true;
	}, [detection]);

	const removeRow = useCallback((key: string) => {
		setRows(rs => rs.filter(r => r.key !== key));
	}, []);

	/** Results with an unknown port 8000 server resolved to the user's pick; unresolved ones keep providerName null. */
	const resolvedResults = useMemo(() => rows.flatMap(r => {
		if (!r.result) { return []; }
		if (r.key === 'port8000' && r.result.status === 'found' && r.result.providerName === null && port8000Pick) {
			return [withProvider(r.result, port8000Pick)];
		}
		return [r.result];
	}), [rows, port8000Pick]);

	/** Every model the picker may offer: found, with a known provider (never the port 8000 placeholder), deduplicated. */
	const pickableModels = useMemo(() => {
		const seen = new Set<string>();
		const out: FoundModel[] = [];
		for (const result of resolvedResults) {
			if (result.status !== 'found' || result.providerName === null) { continue; }
			for (const m of result.models) {
				const k = modelKey(m);
				if (seen.has(k)) { continue; }
				seen.add(k);
				out.push(m);
			}
		}
		return out;
	}, [resolvedResults]);

	const recommended = useMemo(() => recommendModel(pickableModels), [pickableModels]);

	const selectedModel: FoundModel | null =
		(selectedKey !== undefined ? pickableModels.find(m => modelKey(m) === selectedKey) : undefined)
		?? recommended;

	/** True while any row (a default port or an added URL) is still being probed. */
	const isLooking = rows.some(r => !r.result);

	/** Continue: fill in settings from what was found, with one server per provider so the endpoint and the
	 *  chosen model agree. */
	const apply = useCallback(() => {
		detection.apply(oneResultPerProvider(resolvedResults, selectedModel), selectedModel);
	}, [detection, resolvedResults, selectedModel]);

	return {
		rows, isLooking, port8000Pick, setPort8000Pick, rescan, addUrl, removeRow,
		pickableModels, recommended, selectedModel, setSelectedKey, apply,
	};
};

const SmallButton = ({ children, isOn, className = '', ...props }: { isOn?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
	<button
		type='button'
		className={`px-2 py-0.5 rounded text-xs border transition-colors
			${isOn ? 'bg-ze-accent text-ze-on-accent border-ze-accent' : 'bg-ze-bg-1 text-ze-fg-2 border-ze-border-2 hover:bg-ze-bg-2-hover'}
			${className}`}
		{...props}
	>
		{children}
	</button>
);

const LinkButton = ({ children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
	<button type='button' className={`text-ze-link-color hover:underline ${className}`} {...props}>{children}</button>
);

const StatusDot = ({ isOn }: { isOn: boolean }) => (
	<span className={`inline-block w-[7px] h-[7px] rounded-full shrink-0 ${isOn ? 'bg-ze-ok' : 'bg-ze-fg-4'}`} />
);

const ProviderRow = ({ row, state, onAddUrl }: { row: Row, state: ConnectModelState, onAddUrl: (provider: ProviderName | null) => void }) => {
	const { result } = row;
	const isFound = result?.status === 'found';
	const isUnknown8000 = row.key === 'port8000' && isFound && result.providerName === null;

	const label = row.isCustom ? providerTitle(row.provider!)
		: row.key === 'port8000'
			? (isFound && result.providerName ? providerTitle(result.providerName)
				: isUnknown8000 && state.port8000Pick ? providerTitle(state.port8000Pick)
					: 'vLLM or oMLX')
			: providerTitle(row.provider!);

	const n = result?.models.length ?? 0;
	const isOllamaWithoutModels = isFound && result.providerName === 'ollama' && n === 0;
	const networkNote = row.isCustom ? networkNoteOf(row.url) : undefined;

	return (
		<div className='py-2 border-b border-ze-border-4 last:border-b-0'>
			<div className='flex items-center justify-between gap-3'>
				<div className='flex items-center gap-2 min-w-0'>
					<StatusDot isOn={isFound} />
					<span className='truncate text-ze-fg-1'>{label} · {hostPortOf(row.url)}</span>
				</div>
				<div className='flex items-center gap-2 shrink-0 text-ze-fg-3'>
					{!result ? <span>Looking…</span>
						: isFound ? <span className='text-ze-ok'>Found · {n} {n === 1 ? 'model' : 'models'}</span>
							: row.isCustom ? <span>Not running</span>
								: <span>Not running · <LinkButton onClick={() => onAddUrl(row.provider)}>Add URL</LinkButton></span>
					}
					{row.isCustom && <LinkButton className='text-ze-fg-3' aria-label='Remove' title='Remove' onClick={() => state.removeRow(row.key)}>×</LinkButton>}
				</div>
			</div>
			{isUnknown8000 && (
				<div className='flex items-center gap-2 mt-1.5 pl-[15px]'>
					<SmallButton isOn={state.port8000Pick === 'vLLM'} onClick={() => state.setPort8000Pick('vLLM')}>It's vLLM</SmallButton>
					<SmallButton isOn={state.port8000Pick === 'oMLX'} onClick={() => state.setPort8000Pick('oMLX')}>It's oMLX</SmallButton>
				</div>
			)}
			{isOllamaWithoutModels && <div className='mt-1 pl-[15px] text-sm text-ze-fg-3 select-text'>{OLLAMA_PULL_HINT}</div>}
			{networkNote && <div className='mt-1 pl-[15px] text-sm text-ze-warning'>{networkNote}</div>}
		</div>
	);
};

const AddUrlForm = ({ initialProvider, onSubmit, onCancel }: {
	initialProvider: ProviderName,
	onSubmit: (typed: string, provider: ProviderName) => boolean,
	onCancel: () => void,
}) => {
	const [typed, setTyped] = useState('');
	const [provider, setProvider] = useState<ProviderName>(initialProvider);
	const [isUnparsable, setIsUnparsable] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => { inputRef.current?.focus(); }, []);

	const submit = () => {
		if (!typed.trim()) { return; }
		setIsUnparsable(!onSubmit(typed, provider));
	};

	return (
		<div className='py-2'>
			<div className='flex items-center gap-2'>
				<input
					ref={inputRef}
					className='flex-1 min-w-0 px-2 py-1 rounded text-sm bg-ze-bg-1 text-ze-fg-1 border border-ze-border-2 outline-none focus:border-ze-accent'
					placeholder='http://192.168.1.50:11434'
					value={typed}
					onChange={e => { setTyped(e.target.value); setIsUnparsable(false); }}
					onKeyDown={e => {
						if (e.key === 'Enter') { e.preventDefault(); submit(); }
						if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
					}}
				/>
				<select
					className='px-1 py-1 rounded text-sm bg-ze-bg-1 text-ze-fg-1 border border-ze-border-2 outline-none'
					aria-label='Provider'
					value={provider}
					onChange={e => setProvider(e.target.value as ProviderName)}
				>
					{ADD_URL_PROVIDERS.map(p => <option key={p} value={p}>{providerTitle(p)}</option>)}
				</select>
				<SmallButton isOn onClick={submit}>Add</SmallButton>
				<SmallButton onClick={onCancel}>Cancel</SmallButton>
			</div>
			{isUnparsable && <div className='mt-1 text-sm text-ze-fg-3'>Not running</div>}
		</div>
	);
};

export const ConnectModelStep = ({ state }: { state: ConnectModelState }) => {
	/** null: the Add URL form is closed; otherwise the provider it opens with. */
	const [addUrlProvider, setAddUrlProvider] = useState<ProviderName | null>(null);

	const openAddUrl = (provider: ProviderName | null) => setAddUrlProvider(provider ?? 'vLLM');
	const onSubmit = (typed: string, provider: ProviderName) => {
		const ok = state.addUrl(typed, provider);
		if (ok) { setAddUrlProvider(null); }
		return ok;
	};

	const { pickableModels, recommended, selectedModel, isLooking } = state;

	return (
		<div className='flex flex-col gap-4 w-full'>
			<div className='text-2xl text-ze-fg-1'>Connect a model</div>

			<div className='rounded-lg border border-ze-border-4 bg-ze-bg-1 px-4 py-1 text-sm'>
				{state.rows.map(row => <ProviderRow key={row.key} row={row} state={state} onAddUrl={openAddUrl} />)}
				{addUrlProvider !== null
					? <AddUrlForm key={addUrlProvider} initialProvider={addUrlProvider} onSubmit={onSubmit} onCancel={() => setAddUrlProvider(null)} />
					: null}
				<div className='flex items-center gap-4 py-2'>
					{addUrlProvider === null && <LinkButton onClick={() => openAddUrl(null)}>Add URL</LinkButton>}
					<LinkButton disabled={isLooking} className={isLooking ? 'opacity-50 pointer-events-none' : ''} onClick={state.rescan}>Rescan</LinkButton>
				</div>
			</div>

			{pickableModels.length > 0 && (
				<div className='rounded-lg border border-ze-border-4 bg-ze-bg-1 px-4 py-3 text-sm flex flex-col gap-2'>
					<label className='text-ze-fg-1' htmlFor='ze-first-run-model'>Default model</label>
					<select
						id='ze-first-run-model'
						className='px-2 py-1 rounded bg-ze-bg-2 text-ze-fg-1 border border-ze-border-2 outline-none'
						value={selectedModel ? modelKey(selectedModel) : ''}
						onChange={e => state.setSelectedKey(e.target.value)}
					>
						{pickableModels.map(m => <option key={modelKey(m)} value={modelKey(m)}>{m.modelName} ({providerTitle(m.providerName)})</option>)}
					</select>
					{recommended && (
						<div className='text-ze-fg-3'>Recommended for agent work: {recommended.modelName} ({providerTitle(recommended.providerName)})</div>
					)}
				</div>
			)}
		</div>
	);
};
