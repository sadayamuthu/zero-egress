/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Node-side egress enforcement, shared by electron-main (EgressGuard), the extension host (proxyResolver)
// and the shared process. `check(url, kind)` decides and is responsible for recording (and counting) it.
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
// Optionally also polices UDP (dgram Socket#send / Socket#connect, same host:port policy as TCP) and DNS: every
// dns lookup/resolve/reverse call, module-level, promise-based and on Resolver instances, is checked as
// `dns://<name>/`, which the policy allows only for loopback names and configured hosts. Node's own net.connect
// looks a hostname up through dns.lookup, so an allowed connection's lookup is an allowed query.
// Pass the CommonJS module objects (require('http'), ...); patches are mirrored to ESM namespace imports.
//
// Time-of-check/time-of-use: a caller's object is read exactly once (snapshotOptions / fetchInput), every
// destination is computed from that plain copy, and the copy, never the caller's object, is what the original
// receives. A getter or toString that answers differently on a later read therefore cannot move the dial.

import type * as httpType from 'http';
import type * as netType from 'net';
import type * as dgramType from 'dgram';
import * as dns from 'dns';
import * as nodeUrl from 'url';
import { isIP } from 'net';
import { Readable, Writable } from 'stream';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { destinationOf } from '../common/egressLedger.js';
import { describeDestination, isAllowed, isLoopbackHost, targetFromUrl } from '../common/egressPolicy.js';

export interface EgressHookTargets {
	readonly global: { fetch: typeof fetch };
	readonly http: typeof httpType;
	readonly https: typeof httpType;
	readonly net: typeof netType;
	/** Electron's `net` module, where its requests do not go through a session's webRequest filter. */
	readonly electronNet?: { request: Function; fetch?: Function };
	/** UDP: Socket#send and Socket#connect are checked like a TCP destination. */
	readonly dgram?: typeof dgramType;
	/** Name lookups and DNS queries (callback and promise APIs, module functions and Resolver). */
	readonly dns?: typeof dns;
}

/**
 * What a check is for, so the caller can count it once: 'socket' is a connection (net.Socket connect, dgram send
 * or connect), 'lookup' a name query (or a lookup result refused for a loopback name), 'wrapper' the early check of
 * fetch, http(s).request or a redirect hop, whose connection (if any) is checked again as a socket.
 * 'electronNet' is the destination Electron's net.request (or a net.fetch without one) dials: Chromium makes that
 * connection, so no socket check follows, and outside main no session webRequest filter sees it either. It is the
 * only check of such a request a process other than main can count; main counts the request in webRequest instead.
 */
export type EgressCheckKind = 'socket' | 'lookup' | 'wrapper' | 'electronNet';

export type EgressCheck = (url: string, kind: EgressCheckKind) => boolean;

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

/** Electron ClientRequests whose redirects guardRedirects polices. electronFetch follows hops only on these. */
const guardedRequests = new WeakSet<object>();

/** Chromium's limit (and the fetch standard's): the 21st redirect of one fetch is an error. */
const MAX_FETCH_REDIRECTS = 20;

/**
 * Electron's net.fetch (lib/browser/api/net-fetch.ts, fetchWithSession, Electron 34), ported onto a (guarded)
 * net.request. Differences: redirect 'follow' runs as 'manual' with followRedirect() per hop, so each hop is
 * checked and the 20-redirect limit is ours too (Chromium still applies the method/body rules of 301/302/303 and
 * 307/308, since following continues the same loader); non-http(s) schemes and bypassCustomProtocolHandlers are
 * not supported (Electron's internal allowAnyProtocol); no session (utility processes have none).
 * 'error' and 'manual' reject exactly as Electron's own fetch does.
 */
function electronFetch(request: Function, input: string | Request, init: RequestInit | undefined): Promise<Response> {
	return new Promise<Response>((resolve, reject) => {
		let req: Request;
		try {
			req = new Request(input, init); // reads `init` once (WebIDL dictionary); the URL is `input`, already checked
		} catch (e) {
			return reject(e);
		}
		const cancelBody = (reason: unknown) => {
			if (req.body) { req.body.cancel(reason).catch((e: NodeJS.ErrnoException) => { if (e?.code !== 'ERR_INVALID_STATE') { throw e; } }); }
		};
		if (req.signal.aborted) {
			const reason = req.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
			reject(reason);
			cancelBody(reason);
			return;
		}
		const origin = req.headers.get('origin') ?? undefined;
		const credentials = req.credentials !== 'same-origin' || origin ? req.credentials : 'include';
		const follow = req.redirect === 'follow';
		let r: any;
		try {
			r = request({
				method: req.method,
				url: req.url,
				origin,
				credentials,
				cache: req.cache,
				referrerPolicy: req.referrerPolicy,
				redirect: follow ? 'manual' : req.redirect,
			});
		} catch (e) {
			return reject(e);
		}
		let aborted = false;
		req.signal.addEventListener('abort', () => {
			aborted = true;
			const reason = req.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
			reject(reason);
			cancelBody(reason);
			r.abort();
		}, { once: true });
		if (req.mode && (req.mode !== 'cors' || origin)) { r.setHeader('Sec-Fetch-Mode', req.mode); }
		for (const [name, value] of req.headers) { r.setHeader(name, value); }
		if (follow) {
			let redirects = 0;
			r.on('redirect', () => {
				if (!guardedRequests.has(r)) {
					// guardRedirects could not wrap this request (an unexpected Electron shape): its followRedirect()
					// would follow unchecked, so refuse the redirect instead.
					reject(new Error('ZeroEgress refused a redirect it could not check'));
					r.abort();
					return;
				}
				if (++redirects > MAX_FETCH_REDIRECTS) {
					reject(new Error('net::ERR_TOO_MANY_REDIRECTS'));
					r.abort();
					return;
				}
				r.followRedirect(); // checked by guardRedirects; a blocked hop fails the request with our error
			});
		}
		r.on('response', (resp: any) => {
			if (aborted) { return; }
			try {
				const headers = new Headers();
				for (const [name, value] of Object.entries(resp.headers as Record<string, string | string[]>)) {
					headers.set(name, Array.isArray(value) ? value.join(', ') : value);
				}
				const nullBody = [101, 204, 205, 304].includes(resp.statusCode) || req.method === 'HEAD';
				const response = new Response(nullBody ? null : Readable.toWeb(resp) as ReadableStream, { headers, status: resp.statusCode, statusText: resp.statusMessage });
				(response as any).__original_resp = resp;
				resolve(response);
			} catch (e) {
				reject(e);
			}
		});
		r.on('error', (e: Error) => reject(e));
		if (req.body) {
			req.body.pipeTo(Writable.toWeb(r) as WritableStream).then(() => r.end(), () => { });
		} else {
			r.end();
		}
	});
}

export function installEgressNodeHooks(check: EgressCheck, t: EgressHookTargets): IDisposable {
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
		if (!check(url, 'socket')) {
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
					if (check(badUrl, 'lookup')) { check(`invalid-lookup://${encodeURIComponent(bad)}`, 'lookup'); }
					return cb!(egressBlockedError(badUrl));
				});
			};
			return (original as Function).call(this, { ...options, lookup: guardedLookup }, listener);
		}
		return (original as Function).call(this, options, listener);
	} as typeof original);

	patch(t.global, 'fetch', original => async function (input: string | URL | Request, init?: RequestInit) {
		const { url, input: checked } = fetchInput(input);
		if (!check(url, 'wrapper')) { throw egressBlockedError(url); }
		return original.call(globalThis, checked, init);
	} as typeof fetch);

	for (const [mod, defaultPort] of [[t.http, 80], [t.https, 443]] as const) {
		for (const key of ['request', 'get'] as const) {
			patch(mod, key, original => function (this: unknown, ...args: unknown[]) {
				const { url, options, callback } = requestOptions(args, defaultPort);
				if (url === undefined || check(url, 'wrapper')) { return (original as Function).call(this, options, callback); }
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

	/**
	 * Polices the redirects of an Electron ClientRequest created with redirect 'manual'. Electron emits 'redirect'
	 * and, unless followRedirect() is called during that emit, cancels the request with "Redirect was cancelled".
	 * So a hop is followed only through the wrapped followRedirect, which checks the hop's URL first (once per
	 * hop, so one log line). `autoFollow` (the caller asked for 'follow') follows every allowed hop itself; the
	 * caller's listeners still see each 'redirect'. A refused hop's cancellation error is replaced by our error.
	 * If the shape is not as expected the request is returned unwrapped. A caller of net.request then follows
	 * only by calling Electron's own followRedirect() (Electron cancels any redirect it does not); our net.fetch
	 * checks guardedRequests and refuses every redirect of such a request rather than follow it unchecked.
	 */
	const guardRedirects = (request: any, autoFollow: boolean): unknown => {
		if (!request || typeof request.prependListener !== 'function' || typeof request.followRedirect !== 'function' || typeof request.emit !== 'function') {
			return request;
		}
		const followOriginal: Function = request.followRedirect;
		const emitOriginal: Function = request.emit;
		let hop: { url: string; allowed?: boolean } | undefined;
		let refusal: Error | undefined;
		const allowed = (h: { url: string; allowed?: boolean }): boolean => {
			if (h.allowed === undefined) {
				h.allowed = check(h.url, 'wrapper');
				if (!h.allowed) { refusal = egressBlockedError(h.url); }
			}
			return h.allowed;
		};
		request.followRedirect = function (this: unknown) {
			// outside a redirect, Electron's own followRedirect throws "not waiting for a redirect"
			if (!hop) { return followOriginal.call(request); }
			if (allowed(hop)) { return followOriginal.call(request); }
		};
		request.emit = function (this: unknown, event: unknown, ...args: unknown[]) {
			if (event === 'error' && refusal) {
				args[0] = refusal;
				refusal = undefined;
			}
			if (event !== 'redirect') { return emitOriginal.call(this, event, ...args); }
			// Electron emits 'redirect' (statusCode, method, newUrl, headers); the hop lives only for this emit
			hop = { url: String(args[2]) };
			try {
				return emitOriginal.call(this, event, ...args);
			} finally {
				hop = undefined;
			}
		};
		if (autoFollow) {
			request.prependListener('redirect', () => { if (hop && allowed(hop)) { followOriginal.call(request); } });
		}
		guardedRequests.add(request);
		return request;
	};

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
	const guardedRequest = (original: Function) => function (this: unknown, options: unknown, ...rest: unknown[]) {
		// Electron stringifies a truthy `url` of any type; do it once here so it and we see the same string.
		const snapshot = typeof options === 'string' ? options : snapshotOptions(options);
		if (typeof snapshot !== 'string' && snapshot.url) { snapshot.url = String(snapshot.url); }
		// the first URL is the one Electron dials (one 'electronNet' check per request); the rest are defense in depth
		const denied = electronRequestUrls(snapshot).find((url, i) => !check(url, i === 0 ? 'electronNet' : 'wrapper'));
		if (denied !== undefined) { throw egressBlockedError(denied); }
		// Electron follows redirects by default and only the first URL was checked above. 'error' (and any value
		// Electron rejects) can pass as is; 'follow' and 'manual' run as 'manual' behind guardRedirects. A string
		// becomes the object Electron itself would parse it into (node:url legacy parse), so it can carry the policy.
		const policy = (typeof snapshot === 'string' ? undefined : snapshot.redirect) || 'follow';
		if (policy !== 'follow' && policy !== 'manual') { return original.call(this, snapshot, ...rest); }
		const manual = { ...(typeof snapshot === 'string' ? nodeUrl.parse(snapshot) : snapshot), redirect: 'manual' };
		return guardRedirects(original.call(this, manual, ...rest), policy === 'follow');
	};
	const originalRequest = electronNet && typeof electronNet.request === 'function' ? electronNet.request : undefined;
	tryPatch('request', guardedRequest);
	if (originalRequest) {
		// Electron's own net.fetch builds its ClientRequest internally, out of reach of the wrapper above, and with
		// redirect 'manual' it rejects without exposing the Location. So net.fetch is re-implemented on the guarded
		// request: every hop of every fetch goes through guardRedirects. The original net.fetch is never called.
		const request = guardedRequest(originalRequest);
		tryPatch('fetch', () => function (this: unknown, input: unknown, init?: RequestInit) {
			const { url, input: checked } = fetchInput(input);
			if (!check(url, 'wrapper')) { return Promise.reject(egressBlockedError(url)); }
			return electronFetch(request, checked, init);
		});
	} else {
		tryPatch('fetch', original => async function (this: unknown, input: unknown, ...rest: unknown[]) {
			const { url, input: checked } = fetchInput(input);
			if (!check(url, 'electronNet')) { throw egressBlockedError(url); } // no guarded net.request below to count it
			return original.call(this, checked, ...rest);
		});
	}

	if (t.dgram) { patchDgram(t.dgram, check, patch); }
	if (t.dns) { patchDns(t.dns, check, patch); }

	syncBuiltinESMExports();
	return toDisposable(() => {
		while (restore.length) { restore.pop()!(); }
		syncBuiltinESMExports();
	});
}

type Patch = <O extends object, K extends keyof O>(obj: O, key: K, wrap: (original: O[K]) => O[K]) => void;

/** Fails a dgram call the way Node fails it asynchronously: through the callback if there is one, else 'error'. */
function failDgram(socket: dgramType.Socket, err: Error, callback: unknown): void {
	process.nextTick(() => typeof callback === 'function' ? callback(err) : socket.emit('error', err));
}

function isConnected(socket: dgramType.Socket): boolean {
	try {
		socket.remoteAddress();
		return true;
	} catch {
		return false;
	}
}

/**
 * UDP. A send on an unconnected socket and a connect name a destination; both are checked as `host:port`
 * (an omitted address is Node's loopback default). A connected socket's sends go where its checked connect
 * went. Node accepts only a number or string port and a string address, so nothing can answer differently later.
 */
function patchDgram(dgram: typeof dgramType, check: EgressCheck, patch: Patch): void {
	patch(dgram.Socket.prototype, 'send', original => function (this: dgramType.Socket, ...args: unknown[]) {
		if (!isConnected(this)) {
			// Node's argument shuffle: send(msg, offset, length, port, address, cb) or send(msg, port, address, cb)
			let [port, address, callback] = args[4] || (args[3] && typeof args[3] !== 'function') ? [args[3], args[4], args[5]] : [args[1], args[2], args[3]];
			if (typeof address === 'function') { callback = address; address = undefined; }
			const url = destinationUrl(address, port);
			if (!check(url, 'socket')) { return failDgram(this, egressBlockedError(url), callback); }
		}
		return (original as Function).apply(this, args);
	} as typeof original);
	patch(dgram.Socket.prototype, 'connect', original => function (this: dgramType.Socket, ...args: unknown[]) {
		const [port, address, callback] = typeof args[1] === 'function' ? [args[0], undefined, args[1]] : args;
		const url = destinationUrl(address, port);
		if (!check(url, 'socket')) { return failDgram(this, egressBlockedError(url), callback); }
		return (original as Function).apply(this, args);
	} as typeof original);
}

/** The callback-style dns functions and Resolver methods that send a query (or read the hosts file) for a name. */
const DNS_QUERY_METHODS = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'] as const;

function dnsQueryUrl(name: unknown): string {
	if (typeof name !== 'string') { return 'invalid-host://non-string'; }
	if (!name || URL_CONFUSING_HOST.test(name) || /[[\]]/.test(name)) { return `invalid-host://${encodeURIComponent(name)}`; }
	return `dns://${bracket(name)}/`;
}

/**
 * DNS. A query carries its name to whichever resolver the OS (or a Resolver's setServers) uses, so a name is
 * data leaving the machine even when no connection follows. Every query function is checked before it runs:
 * the dns module's own functions (bound to the default resolver, so patching the prototype does not reach them),
 * dns.Resolver.prototype, and the same for dns.promises. A refused query fails as Node fails a lookup, with
 * the error passed to the callback or the promise rejected; it is never sent. The name is a primitive string
 * (Node rejects anything else), so it cannot answer differently later.
 */
function patchDns(dns: typeof import('dns'), check: EgressCheck, patch: Patch): void {
	// lookup() of an IP literal answers locally (getaddrinfo with a numeric host; dgram's bind and send call it
	// for every address), so it is not a query. resolve*() and reverse() of an IP do send one.
	const guardCallback = (obj: any) => {
		for (const key of DNS_QUERY_METHODS) {
			if (typeof obj[key] !== 'function') { continue; }
			patch(obj, key, (original: Function) => function (this: unknown, name: unknown, ...rest: unknown[]) {
				const url = dnsQueryUrl(name);
				if (typeof name !== 'string' || (key === 'lookup' && isIP(name) !== 0) || check(url, 'lookup')) { return original.call(this, name, ...rest); }
				const callback = rest[rest.length - 1];
				const err = Object.assign(egressBlockedError(url), { code: 'ENOTFOUND', hostname: name });
				if (typeof callback === 'function') { process.nextTick(callback, err); return undefined; }
				throw err;
			});
		}
	};
	const guardPromise = (obj: any) => {
		for (const key of DNS_QUERY_METHODS) {
			if (typeof obj[key] !== 'function') { continue; }
			patch(obj, key, (original: Function) => function (this: unknown, name: unknown, ...rest: unknown[]) {
				const url = dnsQueryUrl(name);
				if (typeof name !== 'string' || (key === 'lookup' && isIP(name) !== 0) || check(url, 'lookup')) { return original.call(this, name, ...rest); }
				return Promise.reject(Object.assign(egressBlockedError(url), { code: 'ENOTFOUND', hostname: name }));
			});
		}
	};
	guardCallback(dns);
	guardCallback(dns.Resolver.prototype);
	if (dns.promises) {
		guardPromise(dns.promises);
		guardPromise(dns.promises.Resolver.prototype);
	}
}

/**
 * For processes that never need more than loopback (the shared process): installs the hooks on this
 * process's own modules with an empty allow-list, plus Electron `net` when given. `onBlocked` records;
 * `onAllowed` hears each allowed 'socket' and 'electronNet' check (one per connection, the ledger's counting unit).
 */
export function installLoopbackOnlyEgressHooks(onBlocked: (url: string) => void, electronNet?: EgressHookTargets['electronNet'], onAllowed?: (url: string) => void): IDisposable {
	const require = createRequire(import.meta.url);
	const check: EgressCheck = (url, kind) => {
		if (isAllowed(url, [])) {
			if (kind === 'socket' || kind === 'electronNet') { onAllowed?.(url); }
			return true;
		}
		onBlocked(url);
		return false;
	};
	return installEgressNodeHooks(check, { global: globalThis, http: require('http'), https: require('https'), net: require('net'), dgram: require('dgram'), dns: require('dns'), electronNet });
}

/** How often the extension host and the shared process report their allowed counts to main. */
export const ALLOWED_REPORT_INTERVAL_MS = 10_000;

/**
 * Counts allowed checks per destination in a process other than main and hands them over every interval (and on
 * dispose); an empty interval sends nothing. Only `http://host:port/` leaves the process, never a path or query;
 * non-network URLs are not counted (the ledger would drop them). The timer never keeps the process alive, and a failing `send`
 * is logged, never thrown into a socket hook or the timer.
 */
export class AllowedCountBatcher extends Disposable {
	private readonly counts = new Map<string, number>();

	constructor(
		private readonly send: (counts: { url: string; count: number }[]) => void,
		intervalMs = ALLOWED_REPORT_INTERVAL_MS,
		private readonly logError: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
	) {
		super();
		const timer = setInterval(() => this.flush(), intervalMs);
		(timer as { unref?: () => void }).unref?.();
		this._register(toDisposable(() => {
			clearInterval(timer);
			this.flush();
		}));
	}

	add(url: string): void {
		const d = destinationOf(url);
		if (!d) { return; }
		const key = `http://${d.dest}/`;
		this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
	}

	flush(): void {
		if (!this.counts.size) { return; }
		const counts = [...this.counts].map(([url, count]) => ({ url, count }));
		this.counts.clear();
		try {
			this.send(counts);
		} catch (e) {
			this.logError('ZeroEgress: could not report allowed connections', e);
		}
	}
}
