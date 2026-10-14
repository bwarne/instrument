// Desktop app: starts the same server as `npm start` (sclang, scsynth, Claude calls) inside Electron
// and shows the page in its own window. Run with `npm run app`.
import { app, BrowserWindow, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// .env is a fallback for ANTHROPIC_API_KEY, MODEL, MIDI_PORT etc. (the ⚙ setting is the usual route)
for (const dir of [root, app.getPath('userData')]) {
  if (existsSync(join(dir, '.env'))) process.loadEnvFile(join(dir, '.env'));
}

// A fixed port keeps the page's origin stable, and the page keeps its API key and saved code in
// localStorage, which is per-origin. A random port would lose them on every launch.
const PORT = Number(process.env.INSTRUMENT_PORT) || 47800;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// One instance only: a second would fight over scsynth's port and the scope/MIDI UDP port.
if (!app.requestSingleInstanceLock()) app.exit(0);

let server = null;
let win = null;

async function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 520,
    title: 'Instrument',
    backgroundColor: '#111111', // matches the page, so there's no white flash while it loads
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // The window only ever shows our page; anything else opens in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); shell.openExternal(url); }
  });
  await win.loadURL(ORIGIN);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  const { start } = await import('../server.js');
  try {
    server = await start({ port: PORT, dataDir: app.getPath('userData') });
  } catch (e) {
    dialog.showErrorBox('Instrument could not start',
      e.code === 'EADDRINUSE'
        ? `Port ${PORT} is in use. Is the web version (npm start) or another copy already running?`
        : String(e.message || e));
    app.quit();
    return;
  }
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Closing the window quits: sclang and scsynth shouldn't keep running with nothing to control them.
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => server?.stop());
