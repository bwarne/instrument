// Stubs the page's outside world before its inline script runs, as CLAUDE.md describes: no server,
// no sclang, no network. contextIsolation is off so these land on the page's own window.
const routes = {
  '/status': { supercollider: true, paths: ['/Applications/SuperCollider.app/Contents/MacOS/sclang'] },
  '/key': {
    env: true, envs: { anthropic: true },
    providers: {
      anthropic: { name: 'Claude (Anthropic)', keyUrl: 'https://platform.claude.com/settings/keys', billingUrl: 'https://platform.claude.com/settings/billing' },
      openai: { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
      ollama: { name: 'Ollama (local, free)', baseURL: 'http://localhost:11434/v1', noKey: true, free: true },
      custom: { name: 'Other (OpenAI-compatible)', baseURL: '' },
    },
  },
  '/usage': { entries: [], file: '/tmp/usage.jsonl' },
  '/share': {
    id: 'abcdefghijkm',
    url: 'https://share.example.invalid/s/abcdefghijkm',
    token: 'f'.repeat(48),
    expiresAt: Date.parse('2027-01-13T00:00:00Z'),
  },
  '/unshare': { ok: true },
};

window.__calls = [];
window.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  window.__calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} });
  if (path === '/share' && window.__hold) await window.__hold; // a test can keep the upload pending
  const body = path === '/key' && opts.method === 'POST' ? { ok: true, hint: 'sk-test…cdef', models: ['gpt-test', 'gpt-test-mini'] } : routes[path] ?? { ok: true };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

class FakeSocket {
  constructor() {
    this.readyState = 0;
  }
  send() {}
  close() {}
  addEventListener() {}
}
window.WebSocket = FakeSocket;

window.confirm = () => true;
window.__opened = [];
window.open = (u) => {
  window.__opened.push(u);
  return null;
};
// file:// is not a secure context, so there is no clipboard API to spy on; give it one.
window.__copied = [];
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: async (t) => void window.__copied.push(t) },
  configurable: true,
});
