/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Pure aggregation model for the egress ledger. Keeps only host:port (never a URL path or query),
// bucketed by hour (allowed) or minute (blocked), so the ledger stays small however chatty the app is.

import { dnsQueryHost, isLoopbackHost, isPrivateHost, targetFromUrl } from './egressPolicy.js';

export type EgressOrigin = 'renderer' | 'main' | 'extensionHost' | 'sharedProcess';
export type DestinationKind = 'this machine' | 'local network' | 'internet';

export type LedgerBody =
	| { type: 'session_start'; time: string; version: string; commit: string }
	| { type: 'session_end'; time: string }
	| { type: 'heartbeat'; hour: string }
	| { type: 'allowed'; hour: string; dest: string; kind: DestinationKind; reason: string; origin: EgressOrigin; count: number }
	| { type: 'blocked'; minute: string; dest: string; origin: EgressOrigin; count: number }
	| { type: 'blocked_lookup'; minute: string; host: string; origin: EgressOrigin; count: number }
	| { type: 'audit_state'; time: string; enabled: boolean };

export function kindOfHost(host: string): DestinationKind {
	return isLoopbackHost(host) ? 'this machine' : isPrivateHost(host) ? 'local network' : 'internet';
}

/** Network schemes only: http, https, ws, wss, and the hooks' tcp:// and udp:// forms (which need an explicit port). */
export function destinationOf(url: string): { dest: string; host: string; kind: DestinationKind } | undefined {
	let target = targetFromUrl(url);
	if (!target) {
		const m = /^(?:tcp|udp):\/\/([^/?#]*)/i.exec(url);
		if (m && /:\d+$/.test(m[1])) {
			target = targetFromUrl(`http://${m[1]}/`);
		}
	}
	if (!target) { return undefined; }
	const host = target.host;
	return { dest: host.includes(':') ? `[${host}]:${target.port}` : `${host}:${target.port}`, host, kind: kindOfHost(host) };
}

function truncated(now: number, ms: number): string {
	return new Date(Math.floor(now / ms) * ms).toISOString();
}

const HOUR = 3600_000;
const MINUTE = 60_000;

export class LedgerAggregator {
	private readonly buckets = new Map<string, LedgerBody>();

	addAllowed(url: string, reason: string, origin: EgressOrigin, now: number, count = 1): void {
		const d = destinationOf(url);
		if (!d) { return; }
		const hour = truncated(now, HOUR);
		const key = `allowed|${hour}|${d.dest}|${origin}|${reason}`;
		const row = this.buckets.get(key);
		if (row && row.type === 'allowed') { row.count += count; return; }
		this.buckets.set(key, { type: 'allowed', hour, dest: d.dest, kind: d.kind, reason, origin, count });
	}

	addBlocked(url: string, origin: EgressOrigin, now: number): void {
		const minute = truncated(now, MINUTE);
		let key: string;
		let fresh: LedgerBody;
		if (url.startsWith('dns:')) {
			const host = dnsQueryHost(url);
			if (!host) { return; }
			key = `blocked_lookup|${minute}|${host}|${origin}|`;
			fresh = { type: 'blocked_lookup', minute, host, origin, count: 1 };
		} else {
			const d = destinationOf(url);
			if (!d) { return; }
			key = `blocked|${minute}|${d.dest}|${origin}|`;
			fresh = { type: 'blocked', minute, dest: d.dest, origin, count: 1 };
		}
		const row = this.buckets.get(key);
		if (row && (row.type === 'blocked' || row.type === 'blocked_lookup')) { row.count++; return; }
		this.buckets.set(key, fresh);
	}

	/** Returns the buckets, sorted by time then dest, and empties the aggregator. */
	drain(): LedgerBody[] {
		const rows = [...this.buckets.values()];
		this.buckets.clear();
		const time = (r: LedgerBody) => r.type === 'allowed' ? r.hour : r.type === 'blocked' || r.type === 'blocked_lookup' ? r.minute : '';
		const dest = (r: LedgerBody) => r.type === 'blocked_lookup' ? r.host : r.type === 'allowed' || r.type === 'blocked' ? r.dest : '';
		return rows.sort((a, b) => time(a).localeCompare(time(b)) || dest(a).localeCompare(dest(b)));
	}
}
