/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Node-side egress enforcement, shared by electron-main (EgressGuard), the extension host (proxyResolver)
// and the shared process. `check(url)` decides and is responsible for recording a block.
//
// Enforcement point: net.Socket.prototype.connect. Every TCP connection in Node reaches it: net.connect,
// net.createConnection (including the reference http.Agent captured at startup), tls.connect (TLSSocket
// extends Socket), new http.ClientRequest, undici/fetch, ws, and `new net.Socket().connect()`. Unix
// sockets and pipes (`path`) pass. tls.connect({ socket }) wraps a socket that already went through here.
// A host allowed only for being a loopback *name* (localhost, *.localhost) must also resolve to an allowed
// address, so a custom `lookup` cannot map it elsewhere.
//
// globalThis.fetch and http/https request/get are wrapped too, only so callers get a clean error (and one
// log line) before any socket exists; a blocked request is built as a bare ClientRequest that never dials,
// so proxy-agent's patched request (which may attach its own agent) is never involved.
// Optionally also wraps Electron's `net.request` / `net.fetch` (used by the shared process).
// Pass the CommonJS module objects (require('http'), ...); patches are mirrored to ESM namespace imports.
//
// Time-of-check/time-of-use: a caller's object is read exactly once (snapshotOptions / fetchInput), every
// destination is computed from that plain copy, and the copy, never the caller's object, is what the original
// receives. A getter or toString that answers differently on a later read therefore cannot move the dial.

import type * as httpType from 'http';
import type * as netType from 'net';
import * as dns from 'dns';
import * as nodeUrl from 'url';
import { isIP } from 'net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { describeDestination, isAllowed, isLoopbackHost, targetFromUrl } from '../common/egressPolicy.js';

export interface EgressHookTargets {
	readonly global: { fetch: typeof fetch };
	readonly http: typeof httpType;
	readonly https: typeof httpType;
	readonly net: typeof netType;
	/** Electron's `net` module, where its requests do not go through a session's webRequest filter. */
	readonly electronNet?: { request: Function; fetch?: Function };
}

export function egressBlockedError(url: string): Error {
	return new Error(`ZeroEgress blocked connection to ${describeDestination(url)} (not a configured server)`);
}

function bracket(host: string): string {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** Characters that make a host string mean something else once embedded in a URL (userinfo, fragment, path, ...). */
const URL_CONFUSING_HOST = /[@#/?\\\s\x00-\x1f\x7f]/;

/**
 * The URL `check` sees for a TCP destination, built the way Node will dial it: an empty host is localhost,
 * the port is `Number(port)` (Node's `+port`, so '0x1bb', ' 443' and '443.0' are 443). A host that is not a
 * string, or that could re-parse as a different hostname inside a URL, yields an `invalid-host:` URL, which
 * the policy denies. Brackets are accepted only around a valid IPv6 literal.
 */
function destinationUrl(host: unknown, port: unknown): string {
	const h = host === undefined || host === null || host === '' ? 'localhost' : host;
	if (typeof h !== 'string') {
		return 'invalid-host://non-string';
	}
	const misusedBrackets = /[[\]]/.test(h) && !(/^\[[^[\]]+\]$/.test(h) && isIP(h.slice(1, -1)) === 6);
	if (URL_CONFUSING_HOST.test(h) || misusedBrackets) {
		return `invalid-host://${encodeURIComponent(h)}`;
	}
	const n = port === undefined || port === null || port === '' ? 0 : Number(port);
	if (!Number.isInteger(n) || n < 0 || n > 65535) {
		return `invalid-port://${encodeURIComponent(String(port))}`;
	}
	return `http://${bracket(h)}:${n}/`;
}

/**
 * A plain copy of a caller's options object, taken in one spread so each own getter runs exactly once. The
 * wrappers compute the check from the copy and hand the copy on, so what was checked is what gets dialed.
 * `port` is coerced to a primitive here (Node's `+port`, Electron's `':' + port`) so a stateful valueOf or
 * toString cannot answer differently later. Non-string hosts are left alone: destinationUrl denies them.
 */
function snapshotOptions(options: unknown): Record<string, any> {
	const s: Record<string, any> = { ...(options as object) };
	if (typeof s.port === 'object' && s.port !== null) { s.port = Number(s.port); }
	return s;
}

/** Request#url as the fetch machinery sees it (the request's own state), not a shadowing own property. */
const requestUrl: ((this: Request) => string) | undefined = typeof Request === 'function' ? Object.getOwnPropertyDescriptor(Request.prototype, 'url')?.get : undefined;

/**
 * The URL a fetch input names, read once, and what to hand the original: a Request is passed as is (its URL
 * is internal state, which `new Request(input)` copies); anything else becomes the string we checked.
 */
function fetchInput(input: unknown): { url: string; input: string | Request } {
	if (requestUrl && input instanceof Request) { return { url: requestUrl.call(input), input }; }
	const url = input instanceof URL ? input.href : String(input);
	return { url, input: url };
}

/**
 * Normalizes http(s).request/get arguments the way Node's ClientRequest does, into a snapshot the wrapper also
 * passes on: a string or URL is stringified once and parsed; an object is copied once, and one that Node would
 * duck-type as a URL (href and protocol, no auth or path) is converted like one; URL forms take an optional
 * options object before the callback. `url` is undefined for a unix socket.
 */
function requestOptions(args: unknown[], defaultPort: number): { url: string | undefined; options: any; callback: unknown } {
	const [a, b, c] = args;
	let options: any;
	let callback: unknown;
	let fromUrl = true;
	if (typeof a === 'string' || a instanceof URL) {
		options = { ...nodeUrl.urlToHttpOptions(new URL(String(a))) };
	} else {
		options = snapshotOptions(a);
		fromUrl = Boolean(options.href && options.protocol) && options.auth === undefined && options.path === undefined;
		if (fromUrl) { options = { ...nodeUrl.urlToHttpOptions(options as URL) }; }
	}
	if (!fromUrl || typeof b === 'function') {
		callback = b;
	} else {
		options = { ...options, ...(b as object) };
		callback = c;
	}
	if (options.socketPath) { return { url: undefined, options, callback }; }
	const port = options.port || options.defaultPort || options.agent?.defaultPort || defaultPort;
	return { url: destinationUrl(options.hostname || options.host, port), options, callback };
}

/**
 * Socket#connect arguments as [options snapshot, connectListener], mirroring Node's net.normalizeArgs: an
 * object is the options; a string that is not a number >= 0 (Node's isPipeName) is a pipe path; anything else
 * is the port, with an optional string host. Also accepts Node's internal pre-normalized array.
 */
function connectArgs(args: unknown[]): [{ path?: unknown; host?: unknown; port?: unknown; lookup?: Function }, unknown] {
	const [a, b] = args;
	if (Array.isArray(a)) { return [snapshotOptions(a[0]), a[1]]; }
	const last = args[args.length - 1];
	const listener = typeof last === 'function' ? last : undefined;
	if (a !== null && typeof a === 'object') { return [snapshotOptions(a), listener]; }
	if (typeof a === 'string' && !(Number(a) >= 0)) { return [{ path: a }, listener]; }
	return [typeof b === 'string' ? { port: a, host: b } : { port: a }, listener];
}

/** URL-normalized form of an address, for comparing a lookup result with the parsed destination. */
function normalizedAddress(address: string): string | undefined {
	return targetFromUrl(destinationUrl(address, 0))?.host;
}

/**
 * The URL Electron's net.request dials, computed exactly as Electron's ClientRequest parseOptions does
 * (node:url legacy parse/format): a string is parsed; a truthy `url` wins (stringified, any type); else `host`
 * (host[:port]); else `hostname || 'localhost'` plus `port`; protocol defaults to 'http:'.
 */
function electronDialUrl(options: unknown): string {
	const t: any = typeof options === 'string' ? nodeUrl.parse(options) : { ...(options as object) };
	if (t.url) { return String(t.url); }
	const e: any = { protocol: t.protocol || 'http:' };
	if (t.host) {
		e.host = t.host;
	} else {
		e.hostname = t.hostname || 'localhost';
		if (t.port) { e.port = t.port; }
	}
	const path = nodeUrl.parse(t.path || '/');
	e.pathname = path.pathname;
	e.search = path.search;
	e.hash = path.hash;
	return nodeUrl.format(e);
}

/**
 * Every destination a net.request options value could name: Electron's own choice (above) plus, as defense
 * in depth, each of `url`, `host` and `hostname`+`port` present in it and the raw string. All must be allowed.
 * Odd `host` values follow destinationUrl's invalid-host rule.
 */
function electronRequestUrls(options: unknown): string[] {
	const urls: string[] = [];
	try {
		urls.push(electronDialUrl(options));
	} catch {
		urls.push('invalid-host://electron-options');
	}
	if (typeof options === 'string') {
		urls.push(options);
	} else if (options !== null && typeof options === 'object') {
		const o = options as { url?: unknown; host?: unknown; hostname?: unknown; port?: unknown; protocol?: unknown };
		const protocol = typeof o.protocol === 'string' && o.protocol ? o.protocol : 'http:';
		if (o.url) { urls.push(String(o.url)); }
		if (o.host) {
			urls.push(typeof o.host !== 'string' ? 'invalid-host://non-string'
				: URL_CONFUSING_HOST.test(o.host) ? `invalid-host://${encodeURIComponent(o.host)}`
					: `${protocol}//${o.host}/`);
		}
		const dest = destinationUrl(o.hostname, o.port || (protocol === 'https:' ? 443 : 80));
		urls.push(dest.startsWith('http://') ? `${protocol}${dest.slice('http:'.length)}` : dest);
	}
	return urls;
}

export function installEgressNodeHooks(check: (url: string) => boolean, t: EgressHookTargets): IDisposable {
	const restore: (() => void)[] = [];
	const patch = <O extends object, K extends keyof O>(obj: O, key: K, wrap: (original: O[K]) => O[K]) => {
		const original = obj[key];
		obj[key] = wrap(original);
		restore.push(() => { obj[key] = original; });
	};

	// The choke point. `options` is our snapshot, and it is what the original gets (Node re-normalizes it).
	patch(t.net.Socket.prototype, 'connect', original => function (this: netType.Socket, ...args: unknown[]) {
		const [options, listener] = connectArgs(args);
		if (options.path) { return (original as Function).call(this, options, listener); }
		const url = destinationUrl(options.host, options.port);
		if (!check(url)) {
			// Look like a connect in progress (as the real connect does synchronously) so early writes are
			// buffered rather than failing with 'Socket is closed'; then fail with our error. setImmediate, not
			// nextTick: an http ClientRequest attaches its socket 'error' listener on a later tick.
			(this as { connecting: boolean }).connecting = true;
			setImmediate(() => this.destroy(egressBlockedError(url)));
			return this;
		}
		// Node resolves any host that is not an IP literal (including '[::1]' or '2130706433'), possibly with a
		// caller-supplied lookup. If the decision above relied on the parsed host being loopback or a specific
		// IP, the resolved addresses must match it: loopback names to loopback addresses, IP spellings to that IP.
		const rawHost = (options.host as string | undefined) || 'localhost';
		const parsed = targetFromUrl(url)?.host;
		if (parsed !== undefined && isIP(rawHost) === 0 && (isIP(parsed) !== 0 || isLoopbackHost(parsed))) {
			const acceptable = (address: string) => isLoopbackHost(parsed) ? isLoopbackHost(address) : normalizedAddress(address) === parsed;
			const lookup = (options.lookup ?? dns.lookup) as Function;
			const guardedLookup = (hostname: string, opts: any, cb?: Function) => {
				if (typeof opts === 'function') { cb = opts; opts = {}; }
				lookup(hostname, opts, (err: Error | null, address: string | dns.LookupAddress[], family?: number) => {
					if (err) { return cb!(err, address, family); }
					const addresses = Array.isArray(address) ? address.map(a => a.address) : [address];
					const bad = addresses.find(a => !acceptable(a));
					if (bad === undefined) { return cb!(err, address, family); }
					const badUrl = destinationUrl(bad, options.port);
					// record the block; a configured address reached through a loopback name is still refused
					if (check(badUrl)) { check(`invalid-lookup://${encodeURIComponent(bad)}`); }
					return cb!(egressBlockedError(badUrl));
				});
			};
			return (original as Function).call(this, { ...options, lookup: guardedLookup }, listener);
		}
		return (original as Function).call(this, options, listener);
	} as typeof original);

	patch(t.global, 'fetch', original => async function (input: string | URL | Request, init?: RequestInit) {
		const { url, input: checked } = fetchInput(input);
		if (!check(url)) { throw egressBlockedError(url); }
		return original.call(globalThis, checked, init);
	} as typeof fetch);

	for (const [mod, defaultPort] of [[t.http, 80], [t.https, 443]] as const) {
		for (const key of ['request', 'get'] as const) {
			patch(mod, key, original => function (this: unknown, ...args: unknown[]) {
				const { url, options, callback } = requestOptions(args, defaultPort);
				if (url === undefined || check(url)) { return (original as Function).call(this, options, callback); }
				const err = egressBlockedError(url);
				// A bare ClientRequest whose connection fails with our error: callers see the normal 'error' event.
				const req = new t.http.ClientRequest({
					...options,
					agent: undefined,
					_defaultAgent: mod.globalAgent,
					createConnection: (_o: unknown, cb: (e: Error) => void) => { cb(err); return undefined; },
				} as httpType.ClientRequestArgs, callback as (res: httpType.IncomingMessage) => void);
				if (key === 'get') { req.end(); }
				return req;
			} as typeof original);
		}
	}

	// Best effort: Electron may expose these as getter-only or non-writable, and Chromium's network stack does
	// not go through Node sockets, so Socket#connect cannot stand in for them. Never throw; say so loudly.
	const electronNet = t.electronNet as Record<'request' | 'fetch', Function | undefined> | undefined;
	const tryPatch = (key: 'request' | 'fetch', wrap: (original: Function) => Function) => {
		if (!electronNet || typeof electronNet[key] !== 'function') { return; }
		try {
			const wrapped = wrap(electronNet[key]!);
			patch(electronNet, key, () => wrapped);
			if (electronNet[key] !== wrapped) { throw new Error('assignment did not take effect'); }
		} catch (e) {
			console.error(`ZeroEgress: could not wrap Electron net.${key}; its requests are not policed in this process`, e);
		}
	};
	tryPatch('request', original => function (this: unknown, options: unknown, ...rest: unknown[]) {
		// Electron stringifies a truthy `url` of any type; do it once here so it and we see the same string.
		const snapshot = typeof options === 'string' ? options : snapshotOptions(options);
		if (typeof snapshot !== 'string' && snapshot.url) { snapshot.url = String(snapshot.url); }
		const denied = electronRequestUrls(snapshot).find(url => !check(url));
		if (denied !== undefined) { throw egressBlockedError(denied); }
		return original.call(this, snapshot, ...rest);
	});
	tryPatch('fetch', original => async function (this: unknown, input: unknown, ...rest: unknown[]) {
		const { url, input: checked } = fetchInput(input);
		if (!check(url)) { throw egressBlockedError(url); }
		return original.call(this, checked, ...rest);
	});

	syncBuiltinESMExports();
	return toDisposable(() => {
		while (restore.length) { restore.pop()!(); }
		syncBuiltinESMExports();
	});
}

/**
 * For processes that never need more than loopback (the shared process): installs the hooks on this
 * process's own modules with an empty allow-list, plus Electron `net` when given. `onBlocked` records.
 */
export function installLoopbackOnlyEgressHooks(onBlocked: (url: string) => void, electronNet?: EgressHookTargets['electronNet']): IDisposable {
	const require = createRequire(import.meta.url);
	const check = (url: string) => {
		if (isAllowed(url, [])) { return true; }
		onBlocked(url);
		return false;
	};
	return installEgressNodeHooks(check, { global: globalThis, http: require('http'), https: require('https'), net: require('net'), electronNet });
}
