/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Pure egress policy: which network destinations the app may reach.
// Loopback plus the hosts the user configured, and nothing else. No DNS, no I/O.
// Matching is host+port only; scheme and path are ignored.
//
// Contract for callers (e.g. the Task 13 runtime guard):
// - Pass absolute URLs. Classification uses the WHATWG URL parser (the same one fetch/WebSocket use),
//   never the raw string. Anything that does not parse is denied.
// - Deny by default: only http/https/ws/wss (loopback or exact host+port match) and the explicit
//   NON_NETWORK_PROTOCOLS list are allowed. Unknown schemes are denied.
// - Build targets only via targetFromUrl / collectEgressTargets. Hosts passed straight to
//   isLoopbackHost / isPrivateHost are expected in targetFromUrl-normalized form.

export interface EgressTarget { readonly host: string; readonly port: number; readonly reason?: string }

export interface EgressSources {
	providerEndpoints: readonly string[];
	mcpServerUrls: readonly string[];
	auditCollectorUrl: string | undefined;
}

const NETWORK_PROTOCOLS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };

/** Parsed protocols that never leave the machine and are allowed; any `vscode-*` scheme is also allowed. */
const NON_NETWORK_PROTOCOLS: readonly string[] = ['file:', 'data:', 'blob:', 'devtools:', 'chrome-extension:', 'chrome:', 'about:', 'javascript:'];

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

/** True only for URLs whose parsed scheme is http/https/ws/wss. */
export function isNetworkUrl(url: string): boolean {
	return parseNetworkUrl(url) !== undefined;
}

function isExplicitNonNetwork(url: string): boolean {
	let protocol: string;
	try { protocol = new URL(url).protocol; } catch { return false; }
	return NON_NETWORK_PROTOCOLS.includes(protocol) || protocol.startsWith('vscode-');
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

/**
 * The name a DNS query is for, normalized like a URL host. The Node hooks describe a name lookup (dns.lookup,
 * dns.resolve*, ...) as `dns://<name>/`. Undefined for any other URL.
 */
export function dnsQueryHost(url: string): string | undefined {
	let u: URL;
	try { u = new URL(url); } catch { return undefined; }
	if (u.protocol !== 'dns:' || !u.hostname || u.port || u.username || u.password) { return undefined; }
	return targetFromUrl(`http://${u.hostname}/`)?.host;
}

const REASON_LOOPBACK = 'this machine';
const REASON_MODEL_SERVER = 'model server (set in Settings)';
const REASON_MCP = 'MCP server';
const REASON_AUDIT = 'audit collector';

/** The allow decision: `reason` is undefined for a matched target that carries none. Undefined result means denied. */
function matchAllowed(url: string, targets: readonly EgressTarget[]): { reason: string | undefined } | undefined {
	if (url.startsWith('dns:')) {
		const q = dnsQueryHost(url);
		if (q === undefined) { return undefined; }
		if (isLoopbackHost(q)) { return { reason: REASON_LOOPBACK }; }
		const m = targets.find(x => x.host === q);
		return m && { reason: m.reason };
	}
	const t = targetFromUrl(url);
	// Schemes that never leave the machine are allowed for the same reason as loopback.
	if (!t) { return isExplicitNonNetwork(url) ? { reason: REASON_LOOPBACK } : undefined; }
	if (isLoopbackHost(t.host)) { return { reason: REASON_LOOPBACK }; }
	const m = targets.find(x => x.host === t.host && x.port === t.port);
	return m && { reason: m.reason };
}

/**
 * Why a URL is allowed: `this machine` for loopback (and schemes that never leave the machine), else the reason
 * of the matched target. Undefined when the URL is denied, or when the matched target carries no reason.
 */
export function allowedBy(url: string, targets: readonly EgressTarget[]): string | undefined {
	return matchAllowed(url, targets)?.reason;
}

/**
 * A URL is allowed when it is loopback, matches a configured host and port exactly, or never leaves the
 * machine. A DNS query (`dns://<name>/`) is allowed for loopback names and for the host of any configured
 * target, whatever its port: that is the lookup a connection to it needs.
 */
export function isAllowed(url: string, targets: readonly EgressTarget[]): boolean {
	return matchAllowed(url, targets) !== undefined;
}

/** Short, credential- and path-free name of a destination for logs and errors: `host:port`, else `scheme://host`. */
export function describeDestination(url: string): string {
	const t = targetFromUrl(url);
	if (t) { return `${t.host.includes(':') ? `[${t.host}]` : t.host}:${t.port}`; }
	let u: URL;
	try { u = new URL(url); } catch { return 'unparseable URL'; }
	return u.hostname ? `${u.protocol}//${u.hostname}` : u.protocol;
}

/** The single merge point for allowed destinations; a future admin policy plugs in here (spec 5.3). */
export function collectEgressTargets(s: EgressSources): EgressTarget[] {
	const out: EgressTarget[] = [];
	const seen = new Set<string>();
	const sources: [string | undefined, string][] = [
		...s.providerEndpoints.map((u): [string, string] => [u, REASON_MODEL_SERVER]),
		...s.mcpServerUrls.map((u): [string, string] => [u, REASON_MCP]),
		[s.auditCollectorUrl, REASON_AUDIT],
	];
	for (const [url, reason] of sources) {
		const t0 = url ? targetFromUrl(url) : undefined;
		const t = t0 && { ...t0, reason };
		if (!t) { continue; }
		const key = `${t.host}:${t.port}`;
		if (seen.has(key)) { continue; }
		seen.add(key);
		out.push(t);
	}
	return out;
}

/** One-line Settings warning for a model endpoint that is not loopback or private; undefined otherwise. Never blocks saving. */
export function endpointWarning(url: string): string | undefined {
	const t = targetFromUrl(url);
	if (!t || isLoopbackHost(t.host) || isPrivateHost(t.host)) { return undefined; }
	return 'This server is on the internet; code you send will leave your network.';
}
