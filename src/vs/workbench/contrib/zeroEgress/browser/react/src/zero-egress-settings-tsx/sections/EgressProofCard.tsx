/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Egress Proof: the one-line verdict from this machine's network ledger, and inline panels to create a signed
// report (PDF + JSON) and to verify one. Everything runs in the main process (IEgressProofService); nothing here
// connects anywhere.

import React, { useCallback, useEffect, useState } from 'react'
import type { EgressProofPeriod, EgressProofSummary } from '../../../../../common/egressProofService.js'
import type { ProofCheck } from '../../../../../common/egressProof.js'
import { ZeroEgressButtonBgDarken, ZeroEgressCheckBox, ZeroEgressSimpleInputBox } from '../../util/inputs.js'
import { fileUri, useAccessor, useConfigurationValue } from '../../util/services.js'

// Written out because the bundle keeps imports from outside react/src as written (see AgentsSection.tsx).
const AUDIT_ENABLED_SETTING = 'zeroEgress.audit.enabled' // common/zeroEgressConfiguration.ts
const SHOW_NETWORK_LOG_COMMAND_ID = 'zeroEgress.showNetworkLog'
const SIGNATURE_LIMIT = 'A valid signature proves this report wasn\'t changed and was made with this device\'s key. It does not prove the machine itself wasn\'t tampered with.' // EGRESS_PROOF_SIGNATURE_LIMIT, common/egressProof.ts
const VERIFY_COMMAND = 'node verify-egress-proof.mjs <file>'
const MAX_REPORT_FILE_BYTES = 64 * 1024 * 1024 // as main's MAX_REPORT_FILE_BYTES

type PeriodChoice = '7' | '30' | '90' | 'custom'
const PERIODS: { id: PeriodChoice; label: string }[] = [
	{ id: '7', label: '7 days' },
	{ id: '30', label: '30 days' },
	{ id: '90', label: '90 days' },
	{ id: 'custom', label: 'Custom…' },
]

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
const basename = (p: string) => p.split(/[\\/]/).pop() ?? p
const formatDate = (iso: string) => {
	const d = new Date(iso)
	return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Local `YYYY-MM-DD` to the start of that day; undefined unless it is a real date. */
const parseDay = (s: string): Date | undefined => {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
	if (!m) return undefined
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
	return d.getMonth() === Number(m[2]) - 1 ? d : undefined
}

/** The custom period runs from the start of `from` to the end of `to` (or now, if that is sooner). */
const customPeriod = (from: string, to: string): EgressProofPeriod | string => {
	const f = parseDay(from), t = parseDay(to)
	if (!f || !t) return 'Enter both dates as YYYY-MM-DD.'
	const end = Math.min(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime(), Date.now())
	if (f.getTime() >= end) return 'The start must be before the end.'
	return { from: f.toISOString(), to: new Date(end).toISOString() }
}

const todayString = () => {
	const d = new Date(), p = (n: number) => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const PrimaryButton = ({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) =>
	<button
		disabled={disabled}
		onClick={onClick}
		className={`px-4 py-1 rounded-sm whitespace-nowrap bg-ze-accent text-ze-on-accent ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-ze-accent-hover cursor-pointer'}`}
	>{children}</button>

const IncludeRow = ({ label, value, onChange, disabled, note }: { label: string; value: boolean; onChange?: (v: boolean) => void; disabled?: boolean; note?: string }) =>
	<div className='flex items-center gap-2'>
		<ZeroEgressCheckBox className='w-fit' label={label} value={value} disabled={disabled} onClick={c => onChange?.(c)} />
		<span className={disabled ? 'text-ze-fg-3' : ''}>{label}</span>
		{note ? <span className='text-ze-fg-3'>{note}</span> : null}
	</div>

const CreatePanel = ({ fingerprint, onClose, onCreated }: { fingerprint: string; onClose: () => void; onCreated: () => void }) => {
	const accessor = useAccessor()
	const proofService = accessor.get('IEgressProofService')
	const nativeHostService = accessor.get('INativeHostService')
	const auditEnabled = useConfigurationValue<boolean>(AUDIT_ENABLED_SETTING) === true

	const [period, setPeriod] = useState<PeriodChoice>('7')
	const [from, setFrom] = useState('')
	const [to, setTo] = useState(todayString)
	const [modelUsage, setModelUsage] = useState(true)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | undefined>()
	const [saved, setSaved] = useState<{ jsonPath: string; pdfPath: string } | undefined>()

	const onSave = useCallback(async () => {
		const opts = period === 'custom' ? customPeriod(from, to) : { days: Number(period) }
		if (typeof opts === 'string') { setError(opts); return }
		setError(undefined); setSaved(undefined); setBusy(true)
		try {
			const r = await proofService.createReport(opts, auditEnabled && modelUsage)
			if (r) { setSaved(r); onCreated() }
		} catch (e) {
			setError(errorText(e))
		} finally {
			setBusy(false)
		}
	}, [proofService, period, from, to, auditEnabled, modelUsage, onCreated])

	return <div className='mt-3 rounded-sm border border-ze-border-2 bg-ze-bg-2 px-4 py-3 text-sm flex flex-col gap-3'>
		<div className='text-base'>Create report</div>

		<div className='flex items-center gap-3 flex-wrap'>
			<span>Period</span>
			<div role='radiogroup' aria-label='Period' className='inline-flex rounded-sm border border-ze-border-2 overflow-hidden'>
				{PERIODS.map(p =>
					<button key={p.id} role='radio' aria-checked={period === p.id} onClick={() => { setPeriod(p.id); setError(undefined) }}
						className={`px-3 py-0.5 whitespace-nowrap ${period === p.id ? 'bg-ze-accent text-ze-on-accent' : 'text-ze-fg-2 hover:bg-ze-bg-2-hover'}`}
					>{p.label}</button>
				)}
			</div>
		</div>
		{period === 'custom' ? <div className='flex items-center gap-2 flex-wrap'>
			<span>From</span>
			<ZeroEgressSimpleInputBox value={from} onChangeValue={setFrom} placeholder='YYYY-MM-DD' compact={true} className='max-w-32' aria-label='From date' />
			<span>to</span>
			<ZeroEgressSimpleInputBox value={to} onChangeValue={setTo} placeholder='YYYY-MM-DD' compact={true} className='max-w-32' aria-label='To date' />
		</div> : null}

		<div className='flex flex-col gap-1'>
			<div>Include</div>
			<IncludeRow label='Allowed destinations, with why each was allowed' value={true} disabled={true} />
			<IncludeRow label='Blocked attempts, grouped by destination' value={true} disabled={true} />
			{auditEnabled
				? <IncludeRow label='Model usage counts' value={modelUsage} onChange={setModelUsage} note='(from the audit log)' />
				: <IncludeRow label='Model usage counts' value={false} disabled={true} note='(audit log not enabled)' />}
			<IncludeRow label='App identity: version, build hash, settings that affect the network' value={true} disabled={true} />
		</div>

		<div className='text-ze-fg-3'>Never included: code, prompts, file names, answers.</div>

		<div>
			Signed with this device's ZeroEgress key <span className='font-mono select-text'>{fingerprint || 'unavailable'}</span>{' '}
			<span className='text-ze-fg-3'>(created on this machine; the public half goes in the report)</span>
		</div>

		<div className='flex items-center gap-2 flex-wrap'>
			<PrimaryButton disabled={busy} onClick={onSave}>{busy ? 'Saving…' : 'Save PDF + JSON…'}</PrimaryButton>
			<ZeroEgressButtonBgDarken className='px-4 py-1' onClick={onClose}>{saved ? 'Close' : 'Cancel'}</ZeroEgressButtonBgDarken>
		</div>

		{error ? <div className='text-vscode-error-fg select-text'>{error}</div> : null}
		{saved ? <div className='flex items-center gap-3 flex-wrap'>
			<span className='text-ze-ok select-text'>Saved {basename(saved.pdfPath)} and .json</span>
			<ZeroEgressButtonBgDarken className='px-3 py-0.5' onClick={() => { nativeHostService.showItemInFolder(saved.pdfPath) }}>Show in folder</ZeroEgressButtonBgDarken>
		</div> : null}
	</div>
}

const VerifyPanel = ({ onClose }: { onClose: () => void }) => {
	const accessor = useAccessor()
	const proofService = accessor.get('IEgressProofService')
	const fileService = accessor.get('IFileService')

	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | undefined>()
	const [result, setResult] = useState<{ file: string; checks: ProofCheck[]; fingerprint?: string } | undefined>()

	const onChoose = useCallback(async () => {
		setError(undefined)
		try {
			const picked = await proofService.pickReportFiles()
			if (!picked) return
			setBusy(true); setResult(undefined)
			const checks = await proofService.verifyReport(picked.jsonPath, picked.pdfPath)
			let fingerprint: string | undefined
			try { // the key the report names; shown so it can be compared with the PDF's "Signed by" line
				const content = await fileService.readFile(fileUri(picked.jsonPath), { limits: { size: MAX_REPORT_FILE_BYTES } })
				const fp = JSON.parse(content.value.toString())?.key?.fingerprint
				if (typeof fp === 'string' && fp) fingerprint = fp
			} catch { /* the checks already say why the file is unreadable */ }
			setResult({ file: basename(picked.jsonPath), checks, fingerprint })
		} catch (e) {
			setError(errorText(e))
		} finally {
			setBusy(false)
		}
	}, [proofService, fileService])

	return <div className='mt-3 rounded-sm border border-ze-border-2 bg-ze-bg-2 px-4 py-3 text-sm flex flex-col gap-3'>
		<div className='text-base'>Verify a report</div>
		<div className='text-ze-fg-3'>Choose a report .json (and its .pdf, to check they match). Without the app, run <code className='select-text'>{VERIFY_COMMAND}</code>.</div>
		<div className='flex items-center gap-2 flex-wrap'>
			<PrimaryButton disabled={busy} onClick={onChoose}>{busy ? 'Checking…' : 'Choose report…'}</PrimaryButton>
			<ZeroEgressButtonBgDarken className='px-4 py-1' onClick={onClose}>Close</ZeroEgressButtonBgDarken>
		</div>
		{error ? <div className='text-vscode-error-fg select-text'>{error}</div> : null}
		{result ? <div className='rounded-sm border border-ze-border-2 bg-ze-bg-1 px-3 py-2 flex flex-col gap-1 select-text'>
			<div className='text-ze-fg-3'>{result.file}</div>
			{result.checks.map((c, i) =>
				<div key={i}>
					<span className={c.ok ? 'text-ze-ok' : 'text-vscode-error-fg'}>{c.ok ? '✓' : '✗'} {c.name}</span>
					{c.detail ? <span className='text-ze-fg-3'> · {c.detail}</span> : null}
				</div>
			)}
			<div className='mt-1'>Signed by device key <span className='font-mono'>{result.fingerprint ?? 'unavailable'}</span></div>
		</div> : null}
		<div className='text-ze-fg-3'>{SIGNATURE_LIMIT}</div>
	</div>
}

export const EgressProofCard = () => {
	const accessor = useAccessor()
	const proofService = accessor.get('IEgressProofService')
	const commandService = accessor.get('ICommandService')

	const [summary, setSummary] = useState<EgressProofSummary | undefined>()
	const [loadError, setLoadError] = useState<string | undefined>()
	const [panel, setPanel] = useState<'none' | 'create' | 'verify'>('none')

	const refresh = useCallback(() => {
		proofService.getSummary().then(s => { setSummary(s); setLoadError(undefined) }, e => setLoadError(errorText(e)))
	}, [proofService])
	useEffect(() => { refresh() }, [refresh])

	const since = summary ? formatDate(summary.since) : ''
	return <div className='mt-4 rounded-sm border border-ze-border-2 bg-ze-bg-1 px-4 py-3'>
		<div className='text-base font-semibold'>Egress Proof</div>
		{summary ? <>
			<div className='mt-1 select-text'>
				Since <span className='font-semibold'>{since}</span> (when recording started):{' '}
				{summary.verdict === 'ok'
					? <span className='text-ze-ok'>every connection went to an allowed destination.</span>
					: <span className='text-ze-warning'>every connection went to an allowed destination, with gaps in the record. See the report.</span>}
			</div>
			<div className='text-xs text-ze-fg-3 mt-1 select-text'>{summary.scope}</div>
			<div className='text-sm text-ze-fg-3 mt-2 select-text'>
				{summary.destinations} {summary.destinations === 1 ? 'destination' : 'destinations'} allowed · {summary.blocked} {summary.blocked === 1 ? 'attempt' : 'attempts'} blocked · {summary.intact
					? <>ledger intact <span className='text-ze-ok'>✓</span></>
					: <span className='text-ze-warning'>ledger chain broken</span>}
			</div>
		</> : <div className='text-sm text-ze-fg-3 mt-1'>{loadError ? `Could not read the network ledger: ${loadError}` : 'Reading the network ledger…'}</div>}

		<div className='flex items-center gap-2 mt-3 flex-wrap'>
			<PrimaryButton onClick={() => setPanel(panel === 'create' ? 'none' : 'create')}>Create report…</PrimaryButton>
			<ZeroEgressButtonBgDarken className='px-4 py-1' onClick={() => setPanel(panel === 'verify' ? 'none' : 'verify')}>Verify a report…</ZeroEgressButtonBgDarken>
			<ZeroEgressButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand(SHOW_NETWORK_LOG_COMMAND_ID) }}>View network log</ZeroEgressButtonBgDarken>
		</div>

		{panel === 'create' ? <CreatePanel fingerprint={summary?.fingerprint ?? ''} onClose={() => setPanel('none')} onCreated={refresh} /> : null}
		{panel === 'verify' ? <VerifyPanel onClose={() => setPanel('none')} /> : null}
	</div>
}
