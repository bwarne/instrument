// Desktop app: starts the same server as `npm start` (sclang, scsynth, Claude calls) inside Electron
// and shows the page in its own window. Run with `npm run app`.
import { app, BrowserWindow, Menu, MenuItem, dialog, shell, safeStorage } from 'electron';
import updater from 'electron-updater';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Keep the data folder from before the app was renamed to "AnInstrument": it holds the page's
// localStorage (saved code, conversation), settings.json and the API key, and npm start uses it too.
app.setPath('userData', join(app.getPath('appData'), 'Instrument'));
// .env is a fallback for ANTHROPIC_API_KEY, MODEL, MIDI_PORT etc. (the ⚙ setting is the usual route)
for (const dir of [root, app.getPath('userData')]) {
  if (existsSync(join(dir, '.env'))) process.loadEnvFile(join(dir, '.env'));
}

// A fixed port keeps the page's origin stable, and the page keeps its saved code and settings in
// localStorage, which is per-origin. A random port would lose them on every launch.
const PORT = Number(process.env.INSTRUMENT_PORT) || 47800;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// One instance only: a second would fight over scsynth's port and the scope/MIDI UDP port.
if (!app.requestSingleInstanceLock()) app.exit(0);

let server = null;
let win = null;

// The Anthropic API key, encrypted with safeStorage, whose key lives in the macOS Keychain (under
// "AnInstrument Safe Storage"). The file alone is useless on another Mac or to another app. The dev
// build (npm run app) is signed differently, so macOS may ask before letting it read that entry.
const keyFile = () => join(app.getPath('userData'), 'api-key.bin');
const keyStore = {
  get() {
    if (!existsSync(keyFile()) || !safeStorage.isEncryptionAvailable()) return null;
    try { return safeStorage.decryptString(readFileSync(keyFile())); } catch { return null; }
  },
  set(key) {
    if (!key) return rmSync(keyFile(), { force: true });
    if (!safeStorage.isEncryptionAvailable()) throw new Error("The Keychain isn't available, so the key can't be saved");
    writeFileSync(keyFile(), safeStorage.encryptString(key), { mode: 0o600 });
  },
};

async function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 520,
    title: 'AnInstrument',
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

// --- updates: GitHub Releases, via electron-updater ---
// The packaged app checks at launch and every few hours, downloads a newer release in the background
// and offers to restart into it (or installs it on the next quit). Releases need the .zip and
// latest-mac.yml as well as the .dmg; `npm run publish` uploads them. Not in `npm run app`, which has
// no release to compare against.
const { autoUpdater } = updater;
let manualCheck = false; // from the menu, so say so when there's nothing new or the check fails
function setUpUpdates() {
  autoUpdater.on('update-available', (info) => {
    if (manualCheck) dialog.showMessageBox(win, { message: `Downloading AnInstrument ${info.version}`,
      detail: 'You can keep playing. You\'ll be asked to restart when it\'s ready.' });
    manualCheck = false;
  });
  autoUpdater.on('update-not-available', () => {
    if (manualCheck) dialog.showMessageBox(win, { message: 'AnInstrument is up to date', detail: `Version ${app.getVersion()}` });
    manualCheck = false;
  });
  autoUpdater.on('error', (e) => {
    console.error('update check failed:', e.message);
    if (manualCheck) dialog.showMessageBox(win, { type: 'warning', message: 'Couldn\'t check for updates', detail: e.message });
    manualCheck = false;
  });
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(win, {
      message: `AnInstrument ${info.version} is ready to install`,
      detail: 'Restart now to update (anything playing stops), or it installs the next time you quit.',
      buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // failures arrive as 'error'
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
  // "Check for Updates…" under the app menu, after "About AnInstrument"
  const menu = Menu.getApplicationMenu();
  menu?.items[0]?.submenu?.insert(1, new MenuItem({ label: 'Check for Updates…', click: () => { manualCheck = true; check(); } }));
  if (menu) Menu.setApplicationMenu(menu);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  // The packaged app gets its icon from the bundle; `npm run app` would otherwise show Electron's.
  if (!app.isPackaged) app.dock?.setIcon(join(root, 'build', 'icon.png'));
  const { start } = await import('../server.js');
  try {
    server = await start({ port: PORT, dataDir: app.getPath('userData'), keyStore });
  } catch (e) {
    dialog.showErrorBox('AnInstrument could not start',
      e.code === 'EADDRINUSE'
        ? `Port ${PORT} is in use. Is the web version (npm start) or another copy already running?`
        : String(e.message || e));
    app.quit();
    return;
  }
  await createWindow();
  if (app.isPackaged) setUpUpdates();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Closing the window quits: sclang and scsynth shouldn't keep running with nothing to control them.
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => server?.stop());
