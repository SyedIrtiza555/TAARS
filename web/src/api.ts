const configuredBase = (
  import.meta as unknown as { env: { VITE_API_BASE?: string } }
).env.VITE_API_BASE?.trim();

// Default to the same-origin API prefix. VITE_API_BASE can point at a remote
// origin (for example http://127.0.0.1:8787/api) when the UI is hosted apart.
const BASE = configuredBase ? configuredBase.replace(/\/+$/, '') : '/api';

function notifyUnauthorized(): void {
  try {
    window.dispatchEvent(new Event('wa:unauthorized'));
  } catch {
    /* ignore */
  }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...opts,
    headers: {
      ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...opts.headers,
    },
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error?: unknown }).error || res.statusText)
        : res.statusText || `Request failed (${res.status})`;
    throw new Error(message);
  }

  return data as T;
}

export const api = {
  get: <T = unknown>(p: string) => request<T>(p),
  post: <T = unknown>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T = unknown>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T = unknown>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T = unknown>(p: string) => request<T>(p, { method: 'DELETE' }),
  postForm: <T = unknown>(p: string, form: FormData) => request<T>(p, { method: 'POST', body: form }),
};
