// Headless-browser check for the browser half of dsh-session-importer.
//
// The interesting part of the client plugin is not React state — it is the item
// this plugin injects into another plugin's menu (`@deepseek-ai/dsh-session-log-export`
// owns the Session header's more-actions menu and offers no contribution point).
// That coupling can only be verified against the real rendered markup, so this
// script drives the real Web GUI in a headless Chromium over the DevTools
// Protocol: it opens a Session, opens the real more-actions menu, asserts that
// the injected item sits directly after "Download session log", clicks it, and
// asserts the import dialog opens. Screenshots of both states are written as
// evidence.
//
// Transport: CDP over the global WebSocket (Node 22+), so this needs no
// dependency. The browser itself is launched by scripts/verify-e2e.ps1, which
// owns the scratch instance and the cleanup.
//
// Usage: node scripts/verify-ui.mjs --cdp <port> --base <url> --token <t> [--evidence <dir>]

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** Parsed `--flag value` arguments. */
function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (typeof key !== 'string' || !key.startsWith('--')) continue
    args[key.slice(2)] = argv[i + 1]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const cdpPort = Number(args.cdp)
const base = args.base
const token = args.token
const evidenceDir = args.evidence
const probe = args.probe === 'true'
/** Workspace directory name the imported sessions live under (first-run picker). */
const workspace = args.workspace ?? ''
if (!Number.isInteger(cdpPort) || cdpPort <= 0) throw new Error('--cdp <port> is required')
if (typeof base !== 'string' || base === '') throw new Error('--base <url> is required')
if (typeof token !== 'string' || token === '') throw new Error('--token <token> is required')

/** Sleep for one delay. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait until the DevTools HTTP endpoint answers.
 * @returns the browser websocket URL.
 */
async function browserWebSocketUrl() {
  const deadline = Date.now() + 30000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
      const body = await response.json()
      if (typeof body.webSocketDebuggerUrl === 'string') return body.webSocketDebuggerUrl
    } catch (error) {
      lastError = error
    }
    await sleep(300)
  }
  throw new Error(`the browser never exposed a DevTools endpoint on ${cdpPort}: ${lastError?.message ?? 'no response'}`)
}

/** Minimal CDP client over one websocket: request/response plus flat sessions. */
class Cdp {
  #socket
  #nextId = 1
  #pending = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (typeof message.id !== 'number') return
      const entry = this.#pending.get(message.id)
      if (entry === undefined) return
      this.#pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`))
      else entry.resolve(message.result)
    })
  }

  /**
   * Send one command and await its result.
   * @param method - CDP method name.
   * @param params - command parameters.
   * @param sessionId - optional flat-session target.
   * @returns the command result.
   */
  send(method, params = {}, sessionId) {
    const id = this.#nextId++
    const payload = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#socket.send(JSON.stringify(payload))
    })
  }

  /** Close the transport. */
  close() {
    try {
      this.#socket.close()
    } catch {
      // Already closed.
    }
  }
}

/**
 * Evaluate one async expression in the page and return its value.
 * @param cdp - the client.
 * @param sessionId - the page session.
 * @param expression - an expression evaluating to a promise.
 * @returns the resolved value.
 */
async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId)
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(`in-page evaluation failed: ${detail}`)
  }
  return result.result.value
}

/** Write one screenshot into the evidence directory. */
async function screenshot(cdp, sessionId, name) {
  if (evidenceDir === undefined) return
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  fs.mkdirSync(evidenceDir, { recursive: true })
  const file = path.join(evidenceDir, name)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  process.stderr.write(`wrote ${file}\n`)
}

// --- in-page phases ----------------------------------------------------------

/**
 * Diagnostic dump of the rendered shell.
 *
 * The UI leg asserts against another plugin's markup, so when a DSH release
 * changes that markup the failure needs to be diagnosable without guessing:
 * `--probe` prints what the page actually rendered instead of asserting.
 */
const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/gu, ' ').trim() : '');
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; for (;;) { let v = null; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() > end) return null; await sleep(150); } };
  await waitFor(() => document.body, 30000);
  await waitFor(() => /导入会话|Import session|设置|Settings/u.test(label(document.body)), 60000);
  const out = { url: location.href, menus: [], anchors: [], dialogs: [], sidebar: [], bodyHead: '' };
  const describe = (el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 90), text: label(el).slice(0, 70) });
  for (const m of document.querySelectorAll('[role="menu"]')) out.menus.push(describe(m));
  for (const a of document.querySelectorAll('[aria-haspopup="menu"]')) {
    out.anchors.push({ ...describe(a), ariaLabel: a.getAttribute('aria-label'), expanded: a.getAttribute('aria-expanded') });
  }
  for (const d of document.querySelectorAll('[role="dialog"], [class*="modal" i]')) {
    out.dialogs.push({ ...describe(d), buttons: Array.from(d.querySelectorAll('button')).map(label).slice(0, 6) });
  }
  for (const el of document.querySelectorAll('[class*="session" i], [class*="workspace" i], [class*="group" i]')) {
    const d = describe(el);
    if (d.text !== '') out.sidebar.push(d);
    if (out.sidebar.length >= 40) break;
  }
  out.bodyHead = label(document.body).slice(0, 400);
  return out;
})()`

/**
 * Wait for the app to boot, open a Session so its header exists, then open the
 * more-actions menu and report what it contains. The menu is left open so the
 * caller can screenshot it.
 */
const PREPARE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/gu, ' ').trim() : '');
  // Evaluated as soon as the target exists, which can precede the document body,
  // so every predicate is null-safe and a throwing one counts as "not yet".
  const bodyText = () => (document.body ? document.body.innerText : '');
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; for (;;) { let v = null; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() > end) return null; await sleep(150); } };
  const out = { booted: false, dismissedNotice: false, pickedWorkspace: false, openedSession: false, menuOpen: false, menuItems: [], hasDownload: false, hasImport: false, importAfterDownload: false, injected: false, errors: [] };
  const closeMenus = async () => { for (let i = 0; i < 3; i++) { if (!document.querySelector('[role="menu"]')) return; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(250); } };

  // The sidebar footer action renders only once this plugin's client half is live.
  out.booted = !!(await waitFor(() => /导入会话|Import session/.test(bodyText()), 60000));
  if (!out.booted) { out.errors.push('the import trigger never rendered: the client half did not load'); return out; }

  // A scratch home re-shows the beta notice, which covers everything below it.
  // The onboarding surface has no role="dialog", so it is matched by shape.
  const notice = await waitFor(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const button = buttons.find((b) => /^(继续|知道了|开始使用|Continue|Got it|Start)$/u.test(label(b)));
    if (!button) return null;
    const surface = button.closest('[class*="onboard" i], [class*="notice" i], [class*="hero" i], [class*="card" i]') ?? button.parentElement;
    return surface !== null ? button : null;
  }, 8000);
  if (notice) {
    notice.click();
    out.dismissedNotice = true;
    await sleep(600);
  }

  // A fresh browser profile first asks which workspace to open; the imported
  // sessions live under the archive's own workspace directory name.
  const workspaceTrigger = Array.from(document.querySelectorAll('[aria-haspopup="menu"]'))
    .find((a) => /选择工作区|Choose a workspace/u.test(label(a) + ' ' + String(a.getAttribute('aria-label') || '')));
  if (workspaceTrigger) {
    workspaceTrigger.click();
    const menu = await waitFor(() => document.querySelector('[role="menu"]'), 5000);
    if (menu) {
      await sleep(300);
      const wanted = ${JSON.stringify(workspace)};
      const items = Array.from(menu.querySelectorAll('button[role="menuitem"]'));
      const pick = items.find((b) => wanted !== '' && label(b) === wanted)
        ?? items.find((b) => wanted !== '' && label(b).includes(wanted))
        ?? items.find((b) => !/添加工作区|Add workspace/u.test(label(b)));
      if (pick) { pick.click(); out.pickedWorkspace = true; }
      await sleep(800);
    }
    await closeMenus();
  }

  // A Session header (and its menu) exists only while a Session is open, and the
  // hero only gives way to it once a session with content is selected. Picking a
  // workspace in the first-run hero starts a *blank draft*, so the imported
  // session's own row has to be clicked explicitly.
  const sessionRows = () => Array.from(document.querySelectorAll('[class*="sessionRow" i]'));
  const collectDiag = () => ({
    hero: /描述你想要构建的内容/u.test(bodyText()),
    rows: Array.from(document.querySelectorAll('[class*="Row" i]')).slice(0, 8)
      .map((r) => ({ cls: String(r.className || '').slice(0, 60), text: label(r).slice(0, 40) })),
    anchors: Array.from(document.querySelectorAll('[aria-haspopup="menu"]')).slice(0, 10)
      .map((a) => ({ cls: String(a.className || '').slice(0, 40), aria: String(a.getAttribute('aria-label') || '').slice(0, 30), text: label(a).slice(0, 30) })),
    menus: Array.from(document.querySelectorAll('[role="menu"]')).length,
  });
  await waitFor(() => (sessionRows().length > 0 ? sessionRows() : null), 20000);
  const wanted2 = ${JSON.stringify(workspace)};
  const candidates = sessionRows();
  const target = candidates.find((r) => wanted2 !== '' && label(r).includes(wanted2))
    ?? candidates.find((r) => !/新会话|New session/u.test(label(r)));
  if (target) {
    target.click();
    out.openedSession = true;
    await sleep(1500);
  }
  out.hero = /描述你想要构建的内容/u.test(bodyText());

  // The menu this plugin targets is the one containing the export plugin's
  // download item, so it is found by opening candidate anchors rather than by
  // guessing which button belongs to the session header.
  const downloadRe = /download session log|下载\\s*session\\s*日志/iu;
  let found = null;
  // Prefer the header's own more-actions label so the model/workspace popovers
  // are not opened as collateral; fall back to trying every anchor.
  const anchors = Array.from(document.querySelectorAll('[aria-haspopup="menu"]'));
  const preferred = anchors.filter((a) => /更多操作|more actions/iu.test(String(a.getAttribute('aria-label') || '')));
  for (const anchor of [...preferred, ...anchors.filter((a) => !preferred.includes(a))]) {
    anchor.click();
    const menu = await waitFor(() => {
      const nodes = Array.from(document.querySelectorAll('[role="menu"]'));
      return nodes.find((n) => Array.from(n.querySelectorAll('button[role="menuitem"]')).some((b) => downloadRe.test(label(b)))) ?? null;
    }, 2500);
    if (menu) { found = { anchor, menu }; break; }
    await closeMenus();
  }
  if (!found) {
    out.diag = collectDiag();
    out.errors.push('no open menu contained a "Download session log" item: the Session header never rendered');
    return out;
  }
  out.menuOpen = true;
  // The injector is driven by the menu's own insertion plus a MutationObserver.
  await sleep(500);

  const buttons = Array.from(found.menu.querySelectorAll('button[role="menuitem"]'));
  out.menuItems = buttons.map(label);
  const downloadAt = buttons.findIndex((b) => downloadRe.test(label(b)));
  const importAt = buttons.findIndex((b) => /^(导入会话|import session)$/iu.test(label(b)));
  out.hasDownload = downloadAt >= 0;
  out.hasImport = importAt >= 0;
  out.importAfterDownload = downloadAt >= 0 && importAt === downloadAt + 1;
  out.injected = found.menu.querySelector('[data-dsh-session-importer]') !== null;
  return out;
})()`

/**
 * Click the injected item and report whether the import dialog opened.
 */
const ACTIVATE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/gu, ' ').trim() : '');
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; for (;;) { let v = null; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() > end) return null; await sleep(150); } };
  const out = { clicked: false, menuClosed: false, dialogOpened: false, dialogTitle: '', errors: [] };
  const item = document.querySelector('[data-dsh-session-importer] button[role="menuitem"]');
  if (!item) { out.errors.push('the injected item disappeared before it could be clicked'); return out; }
  item.click();
  out.clicked = true;
  // The dialog is this plugin's own overlay contribution.
  const dialog = await waitFor(() => {
    const nodes = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'));
    return nodes.find((n) => /导入会话|Import session/u.test(label(n))) ?? null;
  }, 8000);
  out.dialogOpened = dialog !== null;
  out.dialogTitle = dialog === null ? '' : label(dialog).slice(0, 120);
  out.menuClosed = document.querySelector('[role="menu"]') === null;
  if (!out.dialogOpened) out.errors.push('clicking the injected item did not open the import dialog');
  return out;
})()`

/**
 * Open the dialog's own workspace menu and measure it.
 *
 * The workspace choice uses the app's `Menu` primitive rather than a native
 * `<select>`, because a native select's popup is painted by the browser and
 * therefore ignores the deployed skin and material. This checks what the user
 * actually reads: the trigger's label, and each menu item's text against its
 * own composited backdrop.
 */
const INSPECT_DIALOG = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/gu, ' ').trim() : '');
  const out = { fields: [], workspaceItems: [], errors: [] };
  const channels = (value) => (String(value).match(/[\\d.]+/gu) || []).slice(0, 4).map(Number);
  const parse = (value) => { const p = channels(value); return { r: p[0] ?? 0, g: p[1] ?? 0, b: p[2] ?? 0, a: p[3] ?? 1 }; };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const f = [c.r, c.g, c.b].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const contrast = (a, b) => { const l1 = lum(a); const l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  // A control may legitimately sit on a translucent surface (a frosted-material
  // skin does), so the backdrop is composited through every ancestor layer.
  const backdrop = (el) => {
    const stack = [];
    for (let node = el; node !== null; node = node.parentElement) {
      const layer = parse(getComputedStyle(node).backgroundColor);
      if (layer.a > 0) stack.push(layer);
    }
    let base = { r: 128, g: 128, b: 128, a: 1 };
    for (let i = stack.length - 1; i >= 0; i -= 1) base = over(stack[i], base);
    return base;
  };
  const measure = (el, name) => {
    const style = getComputedStyle(el);
    const data = { name, color: style.color, backgroundColor: style.backgroundColor };
    data.contrast = Number(contrast(parse(style.color), backdrop(el)).toFixed(2));
    out.fields.push(data);
    return data;
  };

  const dialog = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal" i]'))
    .find((n) => /导入会话|Import session/u.test(label(n)));
  if (!dialog) { out.errors.push('the import dialog is not open'); return out; }

  // The app's Input primitive wraps the field in a span and styles its input.
  const text = dialog.querySelector('input');
  if (!text) out.errors.push('the host-path field is missing');
  else measure(text, 'hostPathInput');

  // The workspace trigger: the dialog's own menu anchor, not a native select.
  const trigger = dialog.querySelector('button[aria-haspopup="menu"]');
  out.usesNativeSelect = dialog.querySelector('select') !== null;
  if (!trigger) { out.errors.push('the workspace menu trigger is missing'); return out; }
  out.triggerLabel = label(trigger);
  measure(trigger, 'workspaceTrigger');
  trigger.click();
  const end = Date.now() + 4000;
  let menu = null;
  while (menu === null && Date.now() < end) {
    menu = Array.from(document.querySelectorAll('[role="menu"]'))
      .find((n) => n.querySelectorAll('button[role="menuitem"]').length >= 3) ?? null;
    if (menu === null) await sleep(120);
  }
  if (menu === null) { out.errors.push('the workspace menu did not open'); return out; }
  await sleep(200);

  // "Too long / cut off": the list must sit inside the viewport and no label may
  // be ellipsized by its own box, in the trigger or in the list.
  const overflow = (el) => el.scrollWidth > el.clientWidth + 1;
  const rect = menu.getBoundingClientRect();
  out.menuRect = { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) };
  out.viewport = { width: window.innerWidth, height: window.innerHeight };
  out.menuClipped = rect.width === 0 || rect.height === 0
    || rect.left < -1 || rect.top < -1
    || rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1;
  out.triggerClipped = overflow(trigger);
  out.triggerWidth = Math.round(trigger.getBoundingClientRect().width);
  out.dialogWidth = Math.round(dialog.getBoundingClientRect().width);

  for (const item of menu.querySelectorAll('button[role="menuitem"]')) {
    const style = getComputedStyle(item);
    const data = {
      name: 'workspaceItem',
      label: label(item),
      color: style.color,
      backgroundColor: style.backgroundColor,
      clipped: overflow(item) || Array.from(item.querySelectorAll('span')).some(overflow),
    };
    data.contrast = Number(contrast(parse(style.color), backdrop(item)).toFixed(2));
    out.workspaceItems.push(data);
  }
  out.menuOpen = true;
  return out;
})()`

// --- run ---------------------------------------------------------------------

const summary = { ok: false, prepare: null, activate: null, errors: [] }
let cdp
try {
  const socket = new WebSocket(await browserWebSocketUrl())
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('could not open the DevTools websocket')), { once: true })
  })
  cdp = new Cdp(socket)

  const { targetId } = await cdp.send('Target.createTarget', { url: `${base}/?token=${encodeURIComponent(token)}` })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)

  if (probe) {
    summary.probe = await evaluate(cdp, sessionId, PROBE)
    await screenshot(cdp, sessionId, 'ui-probe.png')
    summary.ok = true
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    await cdp.send('Browser.close').catch(() => {})
    cdp.close()
    process.exit(0)
  }

  summary.prepare = await evaluate(cdp, sessionId, PREPARE)
  summary.errors.push(...(summary.prepare.errors ?? []))
  await screenshot(cdp, sessionId, 'import-menu.png')

  if (summary.prepare.menuOpen === true && summary.prepare.hasImport === true) {
    summary.activate = await evaluate(cdp, sessionId, ACTIVATE)
    summary.errors.push(...(summary.activate.errors ?? []))
    await screenshot(cdp, sessionId, 'import-dialog.png')
    summary.dialog = await evaluate(cdp, sessionId, INSPECT_DIALOG)
    summary.errors.push(...(summary.dialog.errors ?? []))
  }

  summary.ok = summary.prepare.booted === true
    && summary.prepare.headerAnchor === true
    && summary.prepare.menuOpen === true
    && summary.prepare.hasDownload === true
    && summary.prepare.hasImport === true
    && summary.prepare.importAfterDownload === true
    && summary.prepare.injected === true
    && summary.activate !== null
    && summary.activate.clicked === true
    && summary.activate.dialogOpened === true
  await cdp.send('Browser.close').catch(() => {})
} catch (error) {
  summary.errors.push(error instanceof Error ? error.message : String(error))
} finally {
  cdp?.close()
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
process.exitCode = summary.ok ? 0 : 1
