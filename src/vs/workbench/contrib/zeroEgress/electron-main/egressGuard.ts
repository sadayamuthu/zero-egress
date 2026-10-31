/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Runtime egress guard (electron-main). One instance, constructed in CodeApplication before anything
// can make a request. It holds the allow-list per source, answers check() for the session webRequest
// filter (renderer, webviews, Electron net) and for the main-process Node hooks, and records blocks.
// With a ledger, it also counts: allowed 'request' (webRequest) and 'socket' checks, allowed counts the
// extension host and shared process report, and every block, wherever it was decided.

import { createRequire } from 'node:module';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { BlockedAttempt, EgressSource } from '../common/egressGuardService.js';
import { EgressOrigin, LedgerAggregator } from '../common/egressLedger.js';
import { allowedBy, collectEgressTargets, EgressTarget, isAllowed } from '../common/egressPolicy.js';
import { EgressCheckKind, installEgressNodeHooks } from '../node/egressNodeHooks.js';

const require = createRequire(import.meta.url);

const MAX_RECENT_BLOCKED = 100;

/** Bounds on one reportAllowed batch (10 s of one process's connections); anything beyond is dropped. */
const MAX_REPORTED_ENTRIES = 1000;
const MAX_REPORTED_COUNT = 100_000;

/** Client key used when electron-main itself sets the 'settings' source. */
const MAIN_CLIENT = 'main';

export class EgressGuard extends Disposable {

	/** 'settings' is per client (window): every window holds its own copy of the settings state. */
	private readonly settingsByClient = new Map<string, readonly string[]>();
	/**
	 * Endpoints held by a client's model requests in flight (see leaseSettingsTarget), counted per client.
	 * Part of that client's 'settings': the request carried them as its settings.
	 */
	private readonly leasesByClient = new Map<string, string[]>();
	private readonly urls: Record<Exclude<EgressSource, 'settings'>, readonly string[]> = { mcp: [], audit: [] };
	private _targets: EgressTarget[] = [];
	private readonly _recentBlocked: BlockedAttempt[] = [];

	private readonly _onDidBlock = this._register(new Emitter<BlockedAttempt>());
	readonly onDidBlock: Event<BlockedAttempt> = this._onDidBlock.event;

	private readonly _onDidChangeTargets = this._register(new Emitter<EgressTarget[]>());
	readonly onDidChangeTargets: Event<EgressTarget[]> = this._onDidChangeTargets.event;

	constructor(private readonly ledger?: LedgerAggregator) {
		super();
	}

	get targets(): EgressTarget[] { return this._targets; }

	get recentBlocked(): readonly BlockedAttempt[] { return this._recentBlocked; }

	/** Replaces this source's list; other sources are untouched. */
	setTargets(source: EgressSource, urls: readonly string[]): void {
		if (source === 'settings') {
			this.setSettingsTargets(MAIN_CLIENT, urls);
		} else {
			this.urls[source] = [...urls];
			this.update();
		}
	}

	/** Replaces one client's 'settings' list. The effective 'settings' list is the union over clients. */
	setSettingsTargets(client: string, urls: readonly string[]): void {
		this.settingsByClient.set(client, [...urls]);
		this.update();
	}

	/**
	 * Keeps `url` in `client`'s 'settings' until the returned disposable is disposed. A model request carries the
	 * settings it was made with; leasing its endpoint for the request's lifetime means neither a request that
	 * reaches main ahead of the window's setTargets, nor the SDK's retries of a request made before the user
	 * edited the field (every keystroke replaces the window's list), is blocked. Grants nothing new: the same
	 * client may set any 'settings' list. Leases go with the client in removeSettingsClient.
	 */
	leaseSettingsTarget(client: string, url: string): IDisposable {
		let leases = this.leasesByClient.get(client);
		if (!leases) {
			leases = [];
			this.leasesByClient.set(client, leases);
		}
		leases.push(url);
		this.update();
		const owner = leases;
		return toDisposable(() => {
			if (this.leasesByClient.get(client) !== owner) {
				return; // the client is gone (toDisposable already makes a second dispose a no-op)
			}
			owner.splice(owner.indexOf(url), 1);
			if (!owner.length) {
				this.leasesByClient.delete(client);
			}
			this.update();
		});
	}

	/** Drops a client's 'settings' list and leases (its window closed or reloaded). */
	removeSettingsClient(client: string): void {
		const hadSettings = this.settingsByClient.delete(client);
		const hadLeases = this.leasesByClient.delete(client);
		if (hadSettings || hadLeases) {
			this.update();
		}
	}

	private update(): void {
		const targets = collectEgressTargets({
			providerEndpoints: [...this.settingsByClient.values(), ...this.leasesByClient.values()].flat(),
			mcpServerUrls: this.urls.mcp,
			auditCollectorUrl: this.urls.audit[0],
		});
		// leases come and go with every model request; only a real change is worth pushing to extension hosts
		if (JSON.stringify(targets) === JSON.stringify(this._targets)) {
			return;
		}
		this._targets = targets;
		this._onDidChangeTargets.fire(this._targets);
	}

	/**
	 * True when `url` may be reached. A false result is recorded (and counted) through reportBlocked and fired
	 * on onDidBlock. An allowed 'request' (webRequest) or 'socket' check is counted; 'wrapper' and 'lookup'
	 * checks are not, since the connection behind them is checked (and counted) as a socket, nor is 'electronNet':
	 * main's Electron net requests go through webRequest and are counted there as 'request'.
	 */
	check(url: string, origin: EgressOrigin = 'main', kind: EgressCheckKind | 'request' = 'request'): boolean {
		if (isAllowed(url, this._targets)) {
			if (this.ledger && (kind === 'socket' || kind === 'request')) {
				this.count(ledger => ledger.addAllowed(url, allowedBy(url, this._targets) ?? 'listed target', origin, Date.now()));
			}
			return true;
		}
		this.reportBlocked(url, origin);
		return false;
	}

	/** Records a block, decided here (check) or elsewhere (extension host, shared process), and counts it. */
	reportBlocked(url: string, origin: EgressOrigin): void {
		const attempt: BlockedAttempt = { url, origin, time: Date.now() };
		this._recentBlocked.push(attempt);
		if (this._recentBlocked.length > MAX_RECENT_BLOCKED) {
			this._recentBlocked.shift();
		}
		this.count(ledger => ledger.addBlocked(url, origin, attempt.time));
		this._onDidBlock.fire(attempt);
	}

	/**
	 * Counts connections another process allowed. The reason is today's, from the current targets; a URL no
	 * target matches any more (the list changed since) keeps a generic reason.
	 */
	reportAllowed(counts: readonly { url: string; count: number }[], origin: EgressOrigin): void {
		const now = Date.now();
		this.count(ledger => {
			for (const { url, count } of counts) {
				ledger.addAllowed(url, allowedBy(url, this._targets) ?? 'allowed by that process', origin, now, count);
			}
		});
	}

	/** Counting must never change a decision or throw into a hook: a failure is reported and dropped. */
	private count(add: (ledger: LedgerAggregator) => void): void {
		if (!this.ledger) { return; }
		try {
			add(this.ledger);
		} catch (e) {
			onUnexpectedError(e);
		}
	}

	installNodeHooks(): IDisposable {
		return installEgressNodeHooks((url, kind) => this.check(url, 'main', kind), {
			global: globalThis,
			http: require('http'),
			https: require('https'),
			net: require('net'),
			dgram: require('dgram'),
			dns: require('dns'),
		});
	}
}

/**
 * The 'zero-egress-channel-egress' channel (renderer side: IEgressGuardService). Hand-written rather than
 * ProxyChannel.fromService so 'settings' can be keyed by the calling window (`ctx`).
 * - `canSetSettings`: windows may set 'settings' (their own entry only); nothing may set 'mcp' or 'audit'.
 * - `reportOrigin`: the origin recorded for reportBlocked and reportAllowed from this channel's clients.
 */
export class EgressGuardChannel implements IServerChannel<string> {

	constructor(
		private readonly guard: EgressGuard,
		private readonly options: { readonly canSetSettings: boolean; readonly reportOrigin: EgressOrigin },
	) { }

	listen(_ctx: string, event: string): Event<any> {
		switch (event) {
			case 'onDidBlock': return this.guard.onDidBlock;
			case 'onDidChangeTargets': return this.guard.onDidChangeTargets;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call(ctx: string, command: string, arg?: any): Promise<any> {
		const args: unknown[] = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'setTargets': {
				const [source, urls] = args;
				if (!this.options.canSetSettings || source !== 'settings') {
					throw new Error(`ZeroEgress: egress source '${String(source)}' cannot be set over IPC`);
				}
				this.guard.setSettingsTargets(ctx, Array.isArray(urls) ? urls.filter((u): u is string => typeof u === 'string') : []);
				return;
			}
			case 'getTargets': return this.guard.targets;
			case 'reportBlocked': this.guard.reportBlocked(String(args[0]), this.options.reportOrigin); return;
			case 'reportAllowed': {
				// from another process: keep only well-formed entries, bounded in number and size
				const counts = (Array.isArray(args[0]) ? args[0] : []).filter((c): c is { url: string; count: number } =>
					typeof c === 'object' && c !== null && typeof c.url === 'string' && Number.isSafeInteger(c.count) && c.count > 0);
				this.guard.reportAllowed(counts.slice(0, MAX_REPORTED_ENTRIES).map(c => ({ url: c.url, count: Math.min(c.count, MAX_REPORTED_COUNT) })), this.options.reportOrigin);
				return;
			}
			case 'getRecentBlocked': return [...this.guard.recentBlocked];
		}
		throw new Error(`Call not found: ${command}`);
	}
}
