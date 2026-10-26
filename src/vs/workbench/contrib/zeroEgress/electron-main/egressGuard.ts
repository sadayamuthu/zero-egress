/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Runtime egress guard (electron-main). One instance, constructed in CodeApplication before anything
// can make a request. It holds the allow-list per source, answers check() for the session webRequest
// filter (renderer, webviews, Electron net) and for the main-process Node hooks, and records blocks.

import { createRequire } from 'node:module';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { BlockedAttempt, EgressSource } from '../common/egressGuardService.js';
import { collectEgressTargets, EgressTarget, isAllowed } from '../common/egressPolicy.js';
import { installEgressNodeHooks } from '../node/egressNodeHooks.js';

const require = createRequire(import.meta.url);

const MAX_RECENT_BLOCKED = 100;

/** Client key used when electron-main itself sets the 'settings' source. */
const MAIN_CLIENT = 'main';

export class EgressGuard extends Disposable {

	/** 'settings' is per client (window): every window holds its own copy of the settings state. */
	private readonly settingsByClient = new Map<string, readonly string[]>();
	private readonly urls: Record<Exclude<EgressSource, 'settings'>, readonly string[]> = { mcp: [], audit: [] };
	private _targets: EgressTarget[] = [];
	private readonly _recentBlocked: BlockedAttempt[] = [];

	private readonly _onDidBlock = this._register(new Emitter<BlockedAttempt>());
	readonly onDidBlock: Event<BlockedAttempt> = this._onDidBlock.event;

	private readonly _onDidChangeTargets = this._register(new Emitter<EgressTarget[]>());
	readonly onDidChangeTargets: Event<EgressTarget[]> = this._onDidChangeTargets.event;

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

	/** Drops a client's 'settings' list (its window closed or reloaded). */
	removeSettingsClient(client: string): void {
		if (this.settingsByClient.delete(client)) {
			this.update();
		}
	}

	private update(): void {
		this._targets = collectEgressTargets({
			providerEndpoints: [...this.settingsByClient.values()].flat(),
			mcpServerUrls: this.urls.mcp,
			auditCollectorUrl: this.urls.audit[0],
		});
		this._onDidChangeTargets.fire(this._targets);
	}

	/** True when `url` may be reached. A false result is recorded and fired on onDidBlock. */
	check(url: string, origin: BlockedAttempt['origin'] = 'main'): boolean {
		if (isAllowed(url, this._targets)) {
			return true;
		}
		this.reportBlocked(url, origin);
		return false;
	}

	/** Records a block decided elsewhere (extension host, shared process). */
	reportBlocked(url: string, origin: BlockedAttempt['origin']): void {
		const attempt: BlockedAttempt = { url, origin, time: Date.now() };
		this._recentBlocked.push(attempt);
		if (this._recentBlocked.length > MAX_RECENT_BLOCKED) {
			this._recentBlocked.shift();
		}
		this._onDidBlock.fire(attempt);
	}

	installNodeHooks(): IDisposable {
		return installEgressNodeHooks(url => this.check(url, 'main'), {
			global: globalThis,
			http: require('http'),
			https: require('https'),
			net: require('net'),
		});
	}
}

/**
 * The 'zero-egress-channel-egress' channel (renderer side: IEgressGuardService). Hand-written rather than
 * ProxyChannel.fromService so 'settings' can be keyed by the calling window (`ctx`).
 * - `canSetSettings`: windows may set 'settings' (their own entry only); nothing may set 'mcp' or 'audit'.
 * - `reportOrigin`: the origin recorded for reportBlocked from this channel's clients.
 */
export class EgressGuardChannel implements IServerChannel<string> {

	constructor(
		private readonly guard: EgressGuard,
		private readonly options: { readonly canSetSettings: boolean; readonly reportOrigin: BlockedAttempt['origin'] },
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
			case 'getRecentBlocked': return [...this.guard.recentBlocked];
		}
		throw new Error(`Call not found: ${command}`);
	}
}
