/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Pure egress policy: which network destinations the app may reach.
// Loopback plus the hosts the user configured, and nothing else. No DNS, no I/O.
// Matching is host+port only; scheme and path are ignored.

export interface EgressTarget { readonly host: string; readonly port: number }

export interface EgressSources {
	providerEndpoints: readonly string[];
	mcpServerUrls: readonly string[];
	auditCollectorUrl: string | undefined;
}

const NETWORK_PROTOCOLS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };

function parseNetworkUrl(url: string): URL | undefined {
	let u: URL;
	try { u = new URL(url); } catch { return undefined; }
	return u.protocol in NETWORK_PROTOCOLS ? u : undefined;
}

function normalizeHost(hostname: string): string {
	let h = hostname.toLowerCase();
	if (h.startsWith('[') && h.endsWith(']')) { h = h.slice(1, -1); }
	if (h.endsWith('.')) { h = h.slice(0, -1); }
	return h;
}

export function targetFromUrl(url: string): EgressTarget | undefined {
	const u = parseNetworkUrl(url);
	if (!u) { return undefined; }
	const host = normalizeHost(u.hostname);
	if (!host) { return undefined; }
	const port = u.port ? Number(u.port) : NETWORK_PROTOCOLS[u.protocol];
	return { host, port };
}

/** Scheme-based, so a malformed `http://...` still counts as network (and is then denied by isAllowed). */
export function isNetworkUrl(url: string): boolean {
	return /^\s*(https?|wss?):/i.test(url);
}

function parseIPv4(host: string): number[] | undefined {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) { return undefined; }
	const o = m.slice(1).map(Number);
	return o.every(n => n <= 255) ? o : undefined;
}

/** For IPv4-mapped IPv6 (`::ffff:a.b.c.d` or `::ffff:hhhh:hhhh`), returns the IPv4 octets. */
function mappedIPv4(host: string): number[] | undefined {
	const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
	if (dotted) { return parseIPv4(dotted[1]); }
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
	if (hex) {
		const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
		return [hi >> 8, hi & 255, lo >> 8, lo & 255];
	}
	return undefined;
}

function firstHextet(host: string): number | undefined {
	if (!host.includes(':')) { return undefined; }
	const first = host.split(':')[0];
	if (first === '') { return 0; }
	return /^[0-9a-f]{1,4}$/.test(first) ? parseInt(first, 16) : undefined;
}

export function isLoopbackHost(host: string): boolean {
	const h = normalizeHost(host);
	if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') { return true; }
	const v4 = parseIPv4(h) ?? mappedIPv4(h);
	return !!v4 && (v4[0] === 127 || v4.every(n => n === 0));
}

export function isPrivateHost(host: string): boolean {
	const h = normalizeHost(host);
	const v4 = parseIPv4(h) ?? mappedIPv4(h);
	if (v4) {
		const [a, b] = v4;
		return a === 10
			|| (a === 172 && b >= 16 && b <= 31)
			|| (a === 192 && b === 168)
			|| (a === 169 && b === 254)
			|| (a === 100 && b >= 64 && b <= 127);
	}
	if (h.includes(':')) {
		const f = firstHextet(h);
		return f !== undefined && ((f & 0xfe00) === 0xfc00 || (f & 0xffc0) === 0xfe80);
	}
	if (!h) { return false; }
	return !h.includes('.') || ['.local', '.lan', '.internal', '.home.arpa'].some(s => h.endsWith(s));
}

export function isAllowed(url: string, targets: readonly EgressTarget[]): boolean {
	if (!isNetworkUrl(url)) { return true; }
	const t = targetFromUrl(url);
	if (!t) { return false; }
	if (isLoopbackHost(t.host)) { return true; }
	return targets.some(x => x.host === t.host && x.port === t.port);
}

/** The single merge point for allowed destinations; a future admin policy plugs in here (spec 5.3). */
export function collectEgressTargets(s: EgressSources): EgressTarget[] {
	const out: EgressTarget[] = [];
	const seen = new Set<string>();
	for (const url of [...s.providerEndpoints, ...s.mcpServerUrls, s.auditCollectorUrl]) {
		const t = url ? targetFromUrl(url) : undefined;
		if (!t) { continue; }
		const key = `${t.host}:${t.port}`;
		if (seen.has(key)) { continue; }
		seen.add(key);
		out.push(t);
	}
	return out;
}
