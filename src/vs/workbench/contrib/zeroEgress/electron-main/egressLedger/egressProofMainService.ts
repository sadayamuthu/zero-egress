/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import { createHash } from 'crypto';
import { BrowserWindow, safeStorage } from 'electron';
import { IDialogMainService } from '../../../../../platform/dialogs/electron-main/dialogMainService.js';
import { LedgerRecord } from '../../common/egressLedger.js';
import { EgressTarget } from '../../common/egressPolicy.js';
import { EGRESS_PROOF_SCOPE, EgressProofBody, ProofCheck, buildEgressProof, canonicalProof } from '../../common/egressProof.js';
import { renderProofHtml } from '../../common/egressProofHtml.js';
import { EgressProofPeriod, EgressProofSummary, IEgressProofService } from '../../common/egressProofService.js';
import { LocalAuditStore } from '../audit/localAuditStore.js';
import { EgressLedgerService } from './egressLedgerService.js';
import { EgressProofKey } from './egressProofKey.js';
import { ON_MACHINE_CHECK, ThisMachineLedger, auditCoverage, lastAuditState, periodOf, reportBasePath, reportFileProblem, targetLabel, verifyReportText } from './egressProofReport.js';

const AUDIT_LOOKBACK_MS = 31 * 24 * 3600_000;

export interface EgressProofMainServiceOptions {
	ledger: EgressLedgerService;
	/** Where the signing key lives (the user data folder). */
	keyDir: string;
	machineId: string;
	version: string;
	commit: string;
	getTargets(): readonly EgressTarget[];
	/** The audit store once the audit pipeline is up; undefined before that or if it failed. */
	getAuditStore(): LocalAuditStore | undefined;
	dialog: IDialogMainService;
	onError?: (message: string, error: unknown) => void;
}

/**
 * Reads a renderer-supplied path for verify, bounded: it must be a regular file no bigger than the cap. Stat comes first
 * because opening a FIFO would block; the open handle is checked again so a swapped file can't slip past.
 */
async function readBounded(p: string): Promise<{ data: Buffer } | { problem: string }> {
	try {
		const before = reportFileProblem(await fs.promises.stat(p));
		if (before) { return { problem: before }; }
		const handle = await fs.promises.open(p, 'r');
		try {
			const after = reportFileProblem(await handle.stat());
			if (after) { return { problem: after }; }
			return { data: await handle.readFile() };
		} finally {
			await handle.close();
		}
	} catch (e) {
		return { problem: (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'The file does not exist' : 'The file could not be read' };
	}
}

function localDate(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Builds, signs and verifies Egress Proof reports from the ledger. Served on `zero-egress-channel-egress-proof`. */
export class EgressProofMainService implements Omit<IEgressProofService, '_serviceBrand'> {

	private _key: EgressProofKey | undefined;

	constructor(private readonly opts: EgressProofMainServiceOptions) { }

	private key(): EgressProofKey {
		return this._key ??= EgressProofKey.load(this.opts.keyDir, safeStorage);
	}

	private keyInfo(): EgressProofBody['key'] {
		const k = this.key();
		return { publicKey: k.publicKey, fingerprint: k.fingerprint, storage: k.storage };
	}

	async getSummary(): Promise<EgressProofSummary> {
		const { ledger } = this.opts;
		await ledger.open();
		await ledger.flush();
		const store = ledger.store;
		const since = await store.createdAt();
		const to = new Date().toISOString();
		const chain = await store.verifyChain();
		let key: EgressProofBody['key'] = { publicKey: '', fingerprint: '', storage: 'file' };
		try {
			key = this.keyInfo();
		} catch (e) {
			this.opts.onError?.('[ZeroEgress] Egress Proof signing key unavailable', e); // the summary still shows; only the fingerprint is blank
		}
		const body = buildEgressProof(await store.recordsBetween(since, to), {
			createdAt: to,
			period: { from: since, to },
			identity: { machineId: '', user: '', version: '', commit: '', os: '', networkSettings: [] },
			modelUsage: null,
			brokenAtSeq: chain.ok ? undefined : chain.brokenAtSeq,
			key,
		});
		return {
			since,
			destinations: body.allowed.length,
			blocked: body.blocked.reduce((s, r) => s + r.count, 0) + body.lookupsBlocked.reduce((s, r) => s + r.count, 0),
			intact: chain.ok,
			verdict: body.verdict,
			scope: EGRESS_PROOF_SCOPE,
			fingerprint: body.key.fingerprint,
		};
	}

	async createReport(opts: EgressProofPeriod, includeModelUsage: boolean): Promise<{ jsonPath: string; pdfPath: string } | undefined> {
		periodOf(opts, Date.now()); // reject a bad period before showing the picker
		const picked = await this.opts.dialog.showOpenDialog({
			title: 'Save Egress Proof report to folder',
			buttonLabel: 'Save Here',
			properties: ['openDirectory', 'createDirectory'],
		}, BrowserWindow.getFocusedWindow() ?? undefined);
		const folder = picked.canceled ? undefined : picked.filePaths[0];
		if (!folder) { return undefined; }

		const { ledger } = this.opts;
		await ledger.open();
		await ledger.flush(); // 1. so the report includes counts up to now
		const store = ledger.store;
		const now = Date.now();
		const period = periodOf(opts, now);
		const records = await store.recordsBetween(period.from, period.to); // 2.
		const chain = await store.verifyChain();
		const body = buildEgressProof(records, { // 3.
			createdAt: new Date(now).toISOString(),
			period,
			identity: this.identity(),
			modelUsage: includeModelUsage ? await this.modelUsage(period, records) : null,
			resetSince: ledger.resetSince(),
			brokenAtSeq: chain.ok ? undefined : chain.brokenAtSeq,
			key: this.keyInfo(),
		});
		const pdf = await printToPdf(renderProofHtml(body)); // 4. and 5.

		const base = reportBasePath(folder, localDate(now), fs.existsSync);
		const pdfPath = `${base}.pdf`;
		const jsonPath = `${base}.json`;
		await fs.promises.writeFile(pdfPath, pdf, { flag: 'wx' }); // 6. never overwrite
		body.pdfSha256 = createHash('sha256').update(pdf).digest('hex'); // 7.
		try {
			const signature = this.key().sign(canonicalProof(body)); // 8.
			await fs.promises.writeFile(jsonPath, JSON.stringify({ ...body, signature }, undefined, '\t'), { flag: 'wx' }); // 9.
		} catch (e) {
			await fs.promises.unlink(pdfPath).catch(() => undefined); // no orphan PDF without its JSON
			throw e;
		}
		return { jsonPath, pdfPath };
	}

	async verifyReport(jsonPath: string, pdfPath?: string): Promise<ProofCheck[]> {
		const json = await readBounded(jsonPath);
		if ('problem' in json) {
			return [{ name: 'Report file is readable', ok: false, detail: json.problem }];
		}
		let pdf: Buffer | undefined;
		let pdfError: string | undefined;
		if (pdfPath) {
			const read = await readBounded(pdfPath);
			if ('problem' in read) { pdfError = read.problem; } else { pdf = read.data; }
		}
		const checks = await verifyReportText(json.data.toString('utf8'), pdf, await this.thisMachine());
		if (pdfError !== undefined && !(checks.length === 1 && !checks[0].ok)) {
			const at = checks.findIndex(c => c.name === ON_MACHINE_CHECK);
			checks.splice(at === -1 ? checks.length : at, 0, { name: 'PDF matches JSON', ok: false, detail: `The PDF could not be read: ${pdfError}` });
		}
		return checks;
	}

	async pickReportFiles(): Promise<{ jsonPath: string; pdfPath?: string } | undefined> {
		const picked = await this.opts.dialog.showOpenDialog({
			title: 'Choose an Egress Proof report (.json, and optionally its .pdf)',
			properties: ['openFile', 'multiSelections'],
			filters: [{ name: 'Egress Proof report', extensions: ['json', 'pdf'] }],
		}, BrowserWindow.getFocusedWindow() ?? undefined);
		if (picked.canceled) { return undefined; }
		const pdfPath = picked.filePaths.find(p => p.toLowerCase().endsWith('.pdf'));
		let jsonPath = picked.filePaths.find(p => p.toLowerCase().endsWith('.json'));
		if (!jsonPath && pdfPath && fs.existsSync(pdfPath.slice(0, -4) + '.json')) {
			jsonPath = pdfPath.slice(0, -4) + '.json'; // only the PDF was picked: use the JSON saved next to it
		}
		return jsonPath ? { jsonPath, pdfPath } : undefined;
	}

	private async thisMachine(): Promise<ThisMachineLedger | undefined> {
		try {
			await this.opts.ledger.open();
			const store = this.opts.ledger.store;
			return { machineId: this.opts.machineId, hashAt: seq => store.hashAt(seq), verifyChain: () => store.verifyChain() };
		} catch {
			return undefined; // no ledger on this machine: skip the on-machine check
		}
	}

	private identity(): EgressProofBody['identity'] {
		let user = '';
		try { user = os.userInfo().username; } catch { /* no user name available */ }
		return {
			machineId: this.opts.machineId,
			user,
			version: this.opts.version,
			commit: this.opts.commit,
			os: `${process.platform} ${os.release()}`,
			networkSettings: this.opts.getTargets().map(targetLabel),
		};
	}

	/** Null when the audit log was off for the whole period; otherwise counts per model and when the log was on. */
	private async modelUsage(period: { from: string; to: string }, records: LedgerRecord[]): Promise<EgressProofBody['modelUsage']> {
		const store = this.opts.ledger.store;
		// The audit state at the period's start is the last one recorded before it.
		const lookbackFrom = new Date(Math.max(Date.parse(period.from) - AUDIT_LOOKBACK_MS, Date.parse(await store.createdAt()))).toISOString();
		const before = (await store.recordsBetween(lookbackFrom, period.from)).filter(r => r.seq < (records[0]?.seq ?? Infinity));
		const coverage = auditCoverage(records, period, lastAuditState(before) ?? false);
		if (coverage.length === 0) { return null; }
		const audit = this.opts.getAuditStore();
		return { auditCoverage: coverage, byModel: audit ? await audit.countByModel(period.from, period.to) : [] };
	}
}

/** Renders `html` to a PDF in a hidden, sandboxed window with JavaScript off. The window is always destroyed. */
async function printToPdf(html: string): Promise<Buffer> {
	const win = new BrowserWindow({
		show: false,
		webPreferences: { javascript: false, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, spellcheck: false },
	});
	try {
		win.webContents.on('will-navigate', e => e.preventDefault());
		win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`);
		return await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
	} finally {
		win.destroy();
	}
}
