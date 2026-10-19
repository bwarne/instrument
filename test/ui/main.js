// Checks the page's ⤴ Share wiring in a hidden Electron window with fetch, WebSocket, confirm,
// window.open and the clipboard stubbed (see preload.js), so nothing reaches the server, sclang or
// the network. Run with `npm run test:ui` from the repo root.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PAGE = pathToFileURL(path.join(__dirname, '..', '..', 'index.html')).href;
const problems = [];
let failures = 0;
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.webContents.on('console-message', (e, level, message) => {
    const lvl = e && typeof e === 'object' && 'level' in e ? e.level : level;
    const msg = e && typeof e === 'object' && 'message' in e ? e.message : message;
    if (lvl === 'error' || lvl === 3) problems.push(msg);
  });
  win.webContents.on('render-process-gone', (_e, d) => problems.push(`renderer gone: ${d.reason}`));

  await win.loadURL(PAGE);
  await new Promise((r) => setTimeout(r, 600));

  const run = (js) => win.webContents.executeJavaScript(js, true);
  const settle = () => new Promise((r) => setTimeout(r, 400));

  try {
    check(problems.length === 0, 'the page loads with no console errors', problems.join(' | '));

    const missing = await run(`
      ['shareBtn','takeShare','shareDlg','sharePre','sharePost','shareTitle','shareAudio','shareAudioRow',
       'shareAudioLen','shareGo','shareLink','shareCopy','shareOpen','shareExpires','shareMsg','shareList','shareWhat']
        .filter((id) => !document.getElementById(id))
    `);
    check(missing.length === 0, 'every element the share code uses exists', missing.join(', '));

    // with an empty editor, Share explains itself rather than uploading
    await run(`$('shareBtn').click()`);
    const empty = await run(`({ open: $('shareDlg').open, disabled: $('shareGo').disabled, msg: $('shareMsg').textContent })`);
    check(empty.open === true, 'Share opens the dialog');
    check(empty.disabled === true, 'Share is disabled with an empty editor');
    check(/Nothing in the editor/.test(empty.msg), 'it says why', empty.msg);
    await run(`$('shareDlg').close()`);

    // now with code and a finished take
    await run(`
      $('code').value = 'Pdef(\\\\kick, Pbind(\\\\degree, 0)).play;\\nNdef(\\\\pad, { SinOsc.ar(220) * 0.1 }).play;';
      rec = { state: 'idle', take: { id: '1760000000000', seconds: 102, notes: 48 } };
      $('shareBtn').click();
    `);
    const ready = await run(`({
      disabled: $('shareGo').disabled,
      audioRow: !$('shareAudioRow').hidden,
      audioLen: $('shareAudioLen').textContent,
      checked: $('shareAudio').checked,
      what: $('shareWhat').textContent,
    })`);
    check(ready.disabled === false, 'Share is enabled once there is code');
    check(ready.audioRow === true, 'the take checkbox shows when a take exists');
    check(ready.checked === true && ready.audioLen === '(1:42)', 'the take is included by default, with its length', ready.audioLen);
    check(/2 lines · a 1:42 take/.test(ready.what), 'the header says what will be shared', ready.what);

    await run(`$('shareGo').click()`);
    await settle();
    const posted = await run(`({
      call: window.__calls.find((c) => c.path === '/share'),
      post: !$('sharePost').hidden,
      pre: !$('sharePre').hidden,
      link: $('shareLink').value,
      expires: $('shareExpires').textContent,
      copied: window.__copied,
      saved: JSON.parse(localStorage.getItem('shares') || '[]'),
      status: $('status').textContent,
    })`);
    check(posted.call?.method === 'POST', 'it posts to /share');
    check(posted.call?.body?.takeId === '1760000000000', 'it sends the take id', String(posted.call?.body?.takeId));
    check(posted.call?.body?.audio === true, 'it asks for the audio to be included');
    check(
      JSON.stringify(posted.call?.body?.parts) === JSON.stringify(['pdef:kick', 'ndef:pad']),
      'it sends the parts found in the code',
      JSON.stringify(posted.call?.body?.parts),
    );
    check(posted.post && !posted.pre, 'the dialog switches to showing the link');
    check(posted.link === 'https://share.example.invalid/s/abcdefghijkm', 'the link is shown', posted.link);
    check(/It stops working on \w+ \d+, 2027/.test(posted.expires), 'the expiry date is shown', posted.expires);
    check(posted.copied[0] === posted.link, 'the link is copied to the clipboard');
    check(posted.saved.length === 1 && posted.saved[0].token === 'f'.repeat(48), 'the token is kept for unsharing');
    check(posted.status.endsWith('shared'), 'the status line says shared', posted.status);

    const listed = await run(`({ items: $('shareList').children.length, html: $('shareList').innerHTML })`);
    check(listed.items === 1, 'the share is listed');
    check(/♪ /.test(listed.html), 'the list marks that it has audio');

    await run(`$('shareList').querySelector('[data-unshare]').click()`);
    await settle();
    const after = await run(`({
      call: window.__calls.find((c) => c.path === '/unshare'),
      left: JSON.parse(localStorage.getItem('shares') || '[]').length,
      items: $('shareList').children.length,
      msg: $('shareMsg').textContent,
    })`);
    check(after.call?.body?.id === 'abcdefghijkm', 'Unshare posts the id');
    check(after.call?.body?.token === 'f'.repeat(48), 'Unshare posts the token');
    check(after.left === 0 && after.items === 0, 'it disappears from the list');
    check(/Unshared/.test(after.msg), 'it says so', after.msg);

    await run(`$('shareDlg').close(); $('takeDlg').showModal(); $('takeShare').click()`);
    const handover = await run(`({ take: $('takeDlg').open, share: $('shareDlg').open })`);
    check(handover.take === false && handover.share === true, 'the take dialog hands over to Share');

    await run(`$('shareLink').value = 'https://share.example.invalid/s/abcdefghijkm'; $('shareOpen').click()`);
    const opened = await run(`window.__opened`);
    check(opened[0] === 'https://share.example.invalid/s/abcdefghijkm', 'Open hands the link to the browser');

    check(problems.length === 0, 'no console errors during any of that', problems.join(' | '));
  } catch (e) {
    check(false, 'harness ran without throwing', e.message);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  app.exit(failures ? 1 : 0);
});
