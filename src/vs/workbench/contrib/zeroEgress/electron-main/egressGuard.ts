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
import { BlockedAttempt, EgressSource, IEgressGuardService } from '../common/egressGuardService.js';
import { collectEgressTargets, EgressTarget, isAllowed } from '../common/egressPolicy.js';
import { installEgressNodeHooks } from '../node/egressNodeHooks.js';

const require = createRequire(import.meta.url);

const MAX_RECENT_BLOCKED = 100;

export class EgressGuard extends Disposable {

	private readonly urls: Record<EgressSource, readonly string[]> = { settings: [], mcp: [], audit: [] };
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
		this.urls[source] = [...urls];
		this._targets = collectEgressTargets({
			providerEndpoints: this.urls.settings,
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

	/** Records a block decided elsewhere (the extension host enforces with its own copy of the targets). */
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
			tls: require('tls'),
		});
	}
}

/** The guard as seen over IPC by renderers. Only the 'settings' source may be set from there. */
export class EgressGuardMainService extends Disposable implements IEgressGuardService {
	declare readonly _serviceBrand: undefined;

	readonly onDidBlock: Event<BlockedAttempt>;
	readonly onDidChangeTargets: Event<EgressTarget[]>;

	constructor(private readonly guard: EgressGuard) {
		super();
		this.onDidBlock = guard.onDidBlock;
		this.onDidChangeTargets = guard.onDidChangeTargets;
	}

	async setTargets(source: 'settings', urls: string[]): Promise<void> {
		if (source !== 'settings') {
			throw new Error(`ZeroEgress: egress source '${source}' cannot be set from a renderer`);
		}
		this.guard.setTargets('settings', urls.filter(u => typeof u === 'string'));
	}

	async getTargets(): Promise<EgressTarget[]> {
		return this.guard.targets;
	}

	async reportBlocked(url: string): Promise<void> {
		this.guard.reportBlocked(url, 'extensionHost');
	}

	async getRecentBlocked(): Promise<BlockedAttempt[]> {
		return [...this.guard.recentBlocked];
	}
}
