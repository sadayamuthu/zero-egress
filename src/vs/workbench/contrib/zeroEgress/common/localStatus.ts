/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Pure logic behind the "Local / LAN / Internet" indicator. It classifies the destinations the app
// actually uses; it never claims a byte count, because the guard does not count bytes.

import { EgressTarget, isLoopbackHost, isPrivateHost, targetFromUrl } from './egressPolicy.js';

export type LocalStatusKind = 'local' | 'lan' | 'internet';

export interface LocalStatus {
	readonly kind: LocalStatusKind;
	/** `host:port` of the destinations of the worst kind, sorted. Empty when local. */
	readonly hosts: readonly string[];
}

/** `host:port`, with IPv6 hosts in brackets. */
export function targetLabel(t: EgressTarget): string {
	return `${t.host.includes(':') ? `[${t.host}]` : t.host}:${t.port}`;
}

const sameTarget = (a: EgressTarget, b: EgressTarget) => a.host === b.host && a.port === b.port;

function targetsOf(urls: readonly string[]): EgressTarget[] {
	return urls.map(u => u ? targetFromUrl(u) : undefined).filter((t): t is EgressTarget => !!t);
}

/** Drops a target only when it belongs to an unused provider endpoint and to no used one. */
export function inUseTargets(all: readonly EgressTarget[], unusedProviderEndpoints: readonly string[], usedProviderEndpoints: readonly string[]): EgressTarget[] {
	const unused = targetsOf(unusedProviderEndpoints);
	const used = targetsOf(usedProviderEndpoints);
	return all.filter(t => !unused.some(u => sameTarget(u, t)) || used.some(u => sameTarget(u, t)));
}

/** Internet beats LAN beats local. */
export function localStatusOf(targets: readonly EgressTarget[]): LocalStatus {
	const internet = targets.filter(t => !isLoopbackHost(t.host) && !isPrivateHost(t.host));
	if (internet.length) {
		return { kind: 'internet', hosts: internet.map(targetLabel).sort() };
	}
	const lan = targets.filter(t => !isLoopbackHost(t.host));
	if (lan.length) {
		return { kind: 'lan', hosts: lan.map(targetLabel).sort() };
	}
	return { kind: 'local', hosts: [] };
}

/** Status bar text (with codicon syntax) and tooltip. `undefined` means the guard's state could not be read. */
export function formatLocalStatus(s: LocalStatus | undefined, blocked: number): { text: string; tooltip: string } {
	const logHint = blocked > 0
		? ` Blocked this session: ${blocked}. Click to open the network log.`
		: ' Click to open the network log.';
	if (!s) {
		return { text: '$(question) Status unknown', tooltip: `Couldn't read the network guard's state.${logHint}` };
	}
	const where = s.hosts.length === 1 ? s.hosts[0] : `${s.hosts.length} hosts`;
	let text: string;
	let tooltip: string;
	switch (s.kind) {
		case 'local':
			text = '$(circle-filled) Local';
			tooltip = 'Everything stays on this machine.';
			break;
		case 'lan':
			text = `$(circle-filled) LAN · ${where}`;
			tooltip = `Sends to your network: ${s.hosts.join(', ')}`;
			break;
		case 'internet':
			text = `$(warning) Internet · ${where}`;
			tooltip = `Sends to the internet: ${s.hosts.join(', ')}`;
			break;
	}
	if (blocked > 0) {
		text += ` · ${blocked} blocked`;
	}
	return { text, tooltip: tooltip + logHint };
}
