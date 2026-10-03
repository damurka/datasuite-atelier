/*---------------------------------------------------------------------------------------------
 *  Atelier: GET requests to one academic database -- no faster than it allows, with a timeout, and tried again when
 *  it is busy (429, 5xx) or the network drops, waiting as long as it asks (Retry-After). No imports of vscode.
 *--------------------------------------------------------------------------------------------*/

export type Params = Record<string, string | number | undefined>;

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class HttpError extends Error {
	constructor(readonly status: number, url: string) {
		super(`${new URL(url).host} answered ${status}`);
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
		const abort = () => { clearTimeout(timer); reject(signal?.reason); };
		const timer = setTimeout(done, ms);
		signal?.addEventListener('abort', abort, { once: true });
	});
}

export class HttpClient {

	private readonly minInterval: number;
	/** When the next request may go out. */
	private next = 0;

	constructor(private readonly options: { userAgent: string; timeoutMs?: number; requestsPerSecond?: number; retries?: number }) {
		this.minInterval = options.requestsPerSecond ? 1000 / options.requestsPerSecond : 0;
	}

	async getJson<T = unknown>(url: string, params?: Params, headers?: Record<string, string>, signal?: AbortSignal): Promise<T> {
		return await (await this.get(url, params, { Accept: 'application/json', ...headers }, signal)).json() as T;
	}

	async getText(url: string, params?: Params, headers?: Record<string, string>, signal?: AbortSignal): Promise<string> {
		return (await this.get(url, params, headers, signal)).text();
	}

	async postJson<T = unknown>(url: string, body: unknown, headers?: Record<string, string>, signal?: AbortSignal): Promise<T> {
		return await (await this.get(url, undefined, { Accept: 'application/json', 'Content-Type': 'application/json', ...headers }, signal, JSON.stringify(body))).json() as T;
	}

	private async throttle(signal?: AbortSignal): Promise<void> {
		if (!this.minInterval) {
			return;
		}
		const now = Date.now();
		const at = Math.max(now, this.next);
		this.next = at + this.minInterval;
		if (at > now) {
			await sleep(at - now, signal);
		}
	}

	/** A GET, or with a `body` a POST. */
	private async get(url: string, params: Params | undefined, headers: Record<string, string> | undefined, signal?: AbortSignal, body?: string): Promise<Response> {
		const target = new URL(url.trim());
		for (const [key, value] of Object.entries(params ?? {})) {
			if (value !== undefined && value !== '') {
				target.searchParams.set(key, String(value));
			}
		}
		const retries = this.options.retries ?? 3;
		for (let attempt = 0; ; attempt++) {
			await this.throttle(signal);
			let wait = 1000 * 2 ** attempt;
			try {
				const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 25000);
				const response = await fetch(target, {
					...(body === undefined ? {} : { method: 'POST', body }),
					headers: { 'User-Agent': this.options.userAgent, ...headers },
					signal: signal ? AbortSignal.any([signal, timeout]) : timeout
				});
				if (response.ok) {
					return response;
				}
				if (!RETRY_STATUS.has(response.status) || attempt >= retries) {
					throw new HttpError(response.status, target.href);
				}
				const retryAfter = Number(response.headers.get('retry-after'));
				if (Number.isFinite(retryAfter) && retryAfter > 0) {
					wait = Math.min(retryAfter * 1000, 30000);
				}
			} catch (error) {
				if (signal?.aborted || error instanceof HttpError || attempt >= retries) {
					throw error;
				}
			}
			await sleep(wait, signal);
		}
	}
}
