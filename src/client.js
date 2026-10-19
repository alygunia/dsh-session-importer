// dsh-session-importer: import an exported Session-log ZIP (browser half).
//
// Two entry points share one dialog:
//   sidebar.footer.action                    always-visible "Import session" row/icon
//   the Session header's more-actions menu   an item beside "Download session log"
//
// That menu belongs to `@deepseek-ai/dsh-session-log-export`, which renders its
// items from a literal array — there is no slot or contribution point for a
// second plugin to add one — so the import item is injected into the menu's DOM
// (see `watchMoreMenu`). It is the only way to sit *next to* the download
// action rather than beside it, and the sidebar entry stays as the entry point
// for compositions that do not mount that plugin.
//
// The dialog reads a `dsh-session-<id>.zip` download (file picker or drop) —
// or a host path for a deployment that keeps archives on the server — and
// POSTs it to this plugin's Host route, which performs the import through the
// Session services. The browser's only other job is making the new row appear:
// the Host list is a fresh directory scan but nothing pushes additions for a
// non-live session, so the sessions service is asked to refresh.
//
// Bundle format (client-modules protocol): a classic script registering a
// factory through window.__ModuleLoader__.load({ id, factory }). The factory
// receives `require` and returns the plugin exports. React, react/jsx-runtime,
// and @deepseek-ai/dsh-client-ui-primitives are platform seeds supplied by the
// shell, so this bundle ships neither React nor a build step — only
// React.createElement and theme tokens (--dsw-*).
window.__ModuleLoader__.load({
  id: 'dsh-session-importer',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Modal, Button, Input, Menu,
    } = primitives
    // The primitives renamed their icons from a size suffix to a weight suffix
    // (`IconProjectAddOutline16` → `…Regular`); both names carry the same
    // artwork, so the newer one is preferred and the older one keeps this half
    // working on a 0.1.x shell.
    const ProjectAddIcon = primitives.IconProjectAddOutlineRegular ?? primitives.IconProjectAddOutline16
    const ChevronDownIcon = primitives.IconChevronDownOutlineRegular ?? primitives.IconChevronDownOutline14
    if (ProjectAddIcon === undefined || ChevronDownIcon === undefined) {
      // A shell whose primitives export neither name would render
      // `createElement(undefined)` and crash the whole contribution, so the
      // failure is named here instead of surfacing as a blank sidebar.
      throw new Error('dsh-session-importer: this DSH shell exports no project-add/chevron icon this plugin can render')
    }

    /** Locale namespace owned by this plugin's copy. */
    const NS = 'session-import'
    /** Host route registered by the Host half. */
    const IMPORT_PATH = '/api/session.import'
    /** Slot holding the sidebar's extra footer actions. */
    const FOOTER_SLOT = 'sidebar.footer.action'
    /** Root overlay slot owning the shared dialog. */
    const OVERLAY_SLOT = 'shell.overlay'
    /** Window event both entry points dispatch to open the shared dialog. */
    const OPEN_EVENT = 'dsh-session-importer:open'
    /** Largest archive the dialog offers to upload, matching the Host default. */
    const UPLOAD_WARN_BYTES = 256 * 1024 * 1024

    /** Simplified-Chinese copy. */
    const zh = {
      'action.label': '导入会话',
      'action.title': '导入导出的会话 ZIP',
      'dialog.title': '导入会话',
      'dialog.description': '把一个 dsh-session-<id>.zip 导出文件恢复到这个部署里：会话、子会话和引用的附件都会被重新写入。',
      'dialog.drop': '把 ZIP 拖到这里，或点击选择文件',
      'dialog.selected': '已选择：',
      'dialog.tooLarge': '文件超过 256 MiB 上限，请改用主机路径导入。',
      'dialog.pathLabel': '或从主机路径导入',
      'dialog.pathPlaceholder': '例如 E:\\backup\\dsh-session-xxxx.zip',
      'dialog.workspace': '归入工作区',
      'dialog.workspaceAuto': '自动',
      'dialog.workspaceOriginal': '保持原工作区',
      'dialog.workspaceCurrent': '归入当前工作区',
      'dialog.workspaceAutoHint': '原工作区在本机存在时用它，否则归入当前会话的工作区。',
      'dialog.workspaceOriginalHint': '沿用归档里记录的那个工作区。',
      'dialog.workspaceCurrentHint': '归入当前会话的工作区。',
      'dialog.import': '开始导入',
      'dialog.importing': '正在导入…',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.openSession': '打开会话',
      'dialog.done': '导入完成',
      'dialog.alreadyPresent': '这些会话已存在，本次没有写入任何内容。',
      'dialog.workspaceUnchanged': '它仍在原来的工作区：会话属于「日志 header 里记录的 cwd」对应的那个工作区，而 header 一旦写入就无法改写。要换到别的工作区，请先删除该会话，再选「当前工作区」重新导入。',
      'dialog.workspaceFallback': '未能确定当前会话的工作区，已使用主机启动目录：',
      'dialog.skipped': '已存在，跳过：',
      'dialog.attachments': '附件：',
      'dialog.group': '工作区分组：',
      'dialog.groupNone': '未归入工作区（显示在“未分组”）',
      'dialog.groupNoneReason': '原因：',
      'dialog.networkFailed': '导入请求失败：',
      'dialog.invalidFile': '请选择 .zip 文件。',
    }

    /** English copy. */
    const en = {
      'action.label': 'Import session',
      'action.title': 'Import an exported session ZIP',
      'dialog.title': 'Import session',
      'dialog.description': 'Restore a dsh-session-<id>.zip export into this deployment: the session, its sub-sessions, and its referenced attachments are written again.',
      'dialog.drop': 'Drop a ZIP here, or click to choose a file',
      'dialog.selected': 'Selected: ',
      'dialog.tooLarge': 'That file is over the 256 MiB upload limit; use a host path instead.',
      'dialog.pathLabel': 'Or import from a host path',
      'dialog.pathPlaceholder': 'e.g. E:\\backup\\dsh-session-xxxx.zip',
      'dialog.workspace': 'File under workspace',
      'dialog.workspaceAuto': 'Automatic',
      'dialog.workspaceOriginal': 'Keep archived workspace',
      'dialog.workspaceCurrent': 'Use current workspace',
      'dialog.workspaceAutoHint': 'Uses the archived workspace when it still exists locally, otherwise the current session\u2019s workspace.',
      'dialog.workspaceOriginalHint': 'Files the session under the workspace recorded in the archive.',
      'dialog.workspaceCurrentHint': 'Files the session under the current session\u2019s workspace.',
      'dialog.import': 'Import',
      'dialog.importing': 'Importing…',
      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'dialog.openSession': 'Open session',
      'dialog.done': 'Import finished',
      'dialog.alreadyPresent': 'These sessions already exist, so nothing was written.',
      'dialog.workspaceUnchanged': 'It stays in its original workspace: a session belongs to the workspace matching the cwd recorded in its log header, and a stored header cannot be rewritten. To file it elsewhere, delete that session and import again with "Use current workspace".',
      'dialog.workspaceFallback': 'The current session\u2019s workspace could not be determined, so the host\u2019s own launch directory was used: ',
      'dialog.skipped': 'Already present, skipped: ',
      'dialog.attachments': 'Attachments: ',
      'dialog.group': 'Workspace group: ',
      'dialog.groupNone': 'not filed under a workspace (grouped as "Ungrouped")',
      'dialog.groupNoneReason': 'Reason: ',
      'dialog.networkFailed': 'Import request failed: ',
      'dialog.invalidFile': 'Choose a .zip file.',
    }

    // --- styles ---------------------------------------------------------------

    const footerButtonStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '6px 10px',
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      textAlign: 'left',
    }

    const dropStyle = {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: '18px 14px',
      marginBottom: 12,
      border: '1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.45))',
      borderRadius: 10,
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
      textAlign: 'center',
    }

    const dropActiveStyle = {
      ...dropStyle,
      borderColor: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      color: 'var(--dsw-alias-label-primary, inherit)',
    }

    const fieldStyle = {
      display: 'block',
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      margin: '0 0 4px',
    }

    /** Layout only; the control's own look comes from the app's components. */
    const fieldSpacingStyle = { marginBottom: 12 }

    const statusStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 12,
      lineHeight: '18px',
      marginTop: 10,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }

    const errorStyle = { ...statusStyle, color: 'var(--dsw-alias-state-error-primary, #e5484d)' }

    const linkStyle = {
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 12,
      textDecoration: 'underline',
    }

    // --- the workspace control ------------------------------------------------

    // Both dialog fields are the app's own primitives — `Input` for the path and
    // `Menu` for the workspace choice — rather than hand-styled native controls.
    //
    // The workspace choice started as a native `<select>`, which was wrong for a
    // reason no amount of styling could fix: a native select's fill and its
    // option popup are painted by the browser, so they ignore the theme (and any
    // custom skin or material) while the text around them follows it. Declaring
    // `appearance: none` fixes the closed control but not the popup, which is
    // still browser-drawn. `Menu` renders a real in-page list from the same
    // component every other DSH menu uses, so it inherits whatever the deployed
    // skin does — no color guessing, no `color-scheme` pinning, no popup.
    //
    // Two sizing rules come with that: the option labels stay short (the
    // explanation lives in the hint under the control, because a long parenthetical
    // here both widened the list past the dialog and clipped its own text), and
    // the list is rendered with `portal` so the dialog cannot clip it.

    /** Target-workspace policies: a short label for the list and a hint for the field. */
    const WORKSPACE_POLICIES = [
      { id: 'auto', label: 'dialog.workspaceAuto', hint: 'dialog.workspaceAutoHint' },
      { id: 'original', label: 'dialog.workspaceOriginal', hint: 'dialog.workspaceOriginalHint' },
      { id: 'current', label: 'dialog.workspaceCurrent', hint: 'dialog.workspaceCurrentHint' },
    ]

    /**
     * One policy's field.
     * @param policy - a policy id.
     * @param key - which string to read off the entry.
     * @param t - the active translate function.
     * @returns the display string.
     */
    function workspaceText(policy, key, t) {
      const entry = WORKSPACE_POLICIES.find((candidate) => candidate.id === policy)
      return entry === undefined ? policy : t(entry[key])
    }

    /** A field row's explanatory line under the control. */
    const hintStyle = {
      marginTop: 6,
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      fontSize: 12,
      lineHeight: '18px',
    }

    /**
     * The trigger is deliberately content-sized: it reads as a button rather than
     * a text field, and the hint underneath carries the explanation the long
     * label used to. Only the *list* has to fit, which is what `portal` buys.
     */
    const workspaceTriggerStyle = { gap: 8 }

    // --- locale ---------------------------------------------------------------

    // Module-level handles so both the React dialog and any DOM-less caller see
    // the current services even when they arrived after `apply` ran.
    let sessionsService
    let localeService

    /** Browser-language fallback used when no locale service is mounted. */
    function fallbackLanguage() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    /** Translate one key through the locale service, then the built-in dictionaries. */
    function translate(key) {
      if (localeService && typeof localeService.translate === 'function') {
        const text = localeService.translate(NS, key)
        if (typeof text === 'string' && text !== key) return text
      }
      return (fallbackLanguage() === 'en' ? en : zh)[key] || key
    }

    /** Re-render on locale changes for entries registered without the `t` seat. */
    function useLocaleRevision() {
      const [, setRevision] = useState(0)
      useEffect(() => {
        if (!localeService || typeof localeService.subscribe !== 'function') return undefined
        return localeService.subscribe(() => setRevision((value) => value + 1))
      }, [])
    }

    // --- the Session header's more-actions menu --------------------------------

    // `@deepseek-ai/dsh-session-log-export` builds that menu from a literal item
    // array, so there is no contribution point to use. What the installed Menu
    // primitive renders (and therefore what this depends on) is:
    //
    //   <div role="menu" class="list ...">
    //     <div class="itemWrap"><button type="button" role="menuitem" class="item">
    //       <span class="itemIcon"><svg .../></span>
    //       <span class="itemLabel">下载 Session 日志</span>
    //     </button></div>
    //     ...
    //
    // Three properties of that contract make injection safe here: the wrapper
    // markup is cloned from the download item, so the entry inherits the
    // primitive's own classes, hover treatment, and locale-agnostic styling
    // without this plugin knowing a single hashed class name; the menu walks
    // `button:not(:disabled)` live for arrow-key navigation, so an injected
    // button joins the keyboard model for free; and the menu is rebuilt on every
    // open, so there is no long-lived DOM to keep in sync — injection is driven
    // by the menu's own insertion and is a no-op when nothing matches.

    /** Marks the item this plugin injected, for idempotence, refresh, and cleanup. */
    const MENU_ITEM_ATTR = 'data-dsh-session-importer'

    /** Labels the export plugin ships for its download item, normalized for matching. */
    const DOWNLOAD_LABELS = new Set(['download session log', '下载 session 日志'])

    /**
     * Icon copied from the primitives' `IconProjectAddOutlineRegular` (folder +
     * plus), artwork and stroke width included, so the injected menu item shows
     * exactly the icon the dialog renders. Inlined as markup because an injected
     * node is outside React's tree; the source of truth stays the primitive.
     */
    const MORE_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1">'
      + '<path fill="currentColor" d="M5.54492 2.06738C5.91034 2.06754 6.26318 2.20149 6.53711 2.44336L7.94043 3.68164V4.7998C7.71462 4.74105 7.50367 4.63139 7.32617 4.47461L5.87598 3.19238C5.78477 3.11185 5.66658 3.06754 5.54492 3.06738H2.94922C2.67322 3.06738 2.44946 3.29145 2.44922 3.56738V12.4326C2.44927 12.7087 2.67311 12.9326 2.94922 12.9326H12.9326C13.2086 12.9325 13.4326 12.7086 13.4326 12.4326V8.53613H14.4326V12.4326C14.4326 13.2609 13.7609 13.9325 12.9326 13.9326H2.94922C2.12083 13.9326 1.44927 13.261 1.44922 12.4326V3.56738C1.44946 2.73916 2.12094 2.06738 2.94922 2.06738H5.54492Z"/>'
      + '<path stroke="currentColor" d="M9.75977 4.50208H14.5509"/>'
      + '<path stroke="currentColor" d="M12.1492 6.89758L12.1492 2.10642"/>'
      + '</svg>'

    /**
     * Normalize one menu label for comparison.
     * @param value - raw element text.
     * @returns the collapsed, lowercased label.
     */
    function normalizeLabel(value) {
      return String(value || '').replace(/\s+/gu, ' ').trim().toLowerCase()
    }

    /** Whether the user's active language is English (for label matching only). */
    function prefersEnglish() {
      return fallbackLanguage() === 'en'
    }

    /**
     * Close the menus a click on the injected item would otherwise leave open,
     * so the dialog is not rendered behind an open list.
     *
     * The injected node is outside React's tree and its anchor is not reachable
     * from it, so the menu is dismissed the way the primitive itself documents:
     * a keydown Escape it handles, plus an outside pointerdown as the fallback.
     * A document-wide `[aria-expanded="true"]` anchor search is deliberately not
     * used — the page can hold another anchor reporting an open menu, and
     * clicking that one would *open* a list instead of closing this one.
     * @returns nothing.
     */
    function closeOpenMenu() {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    }

    /**
     * One label for the injected item, matched to the language the download item
     * itself is showing so the two entries never disagree.
     * @param downloadLabel - the download item's rendered label.
     * @returns the import label.
     */
    function importLabelFor(downloadLabel) {
      const english = /download session log/iu.test(String(downloadLabel || '')) || (downloadLabel === '' && prefersEnglish())
      return english ? en['action.label'] : zh['action.label']
    }

    /**
     * Add the import item to one open more-actions menu, if it is that menu.
     * @returns whether an item was injected by this call.
     */
    function injectMoreMenuItem() {
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        if (menu.querySelector('[' + MENU_ITEM_ATTR + ']') !== null) continue
        let download = null
        for (const candidate of menu.querySelectorAll('button[role="menuitem"]')) {
          if (DOWNLOAD_LABELS.has(normalizeLabel(candidate.textContent))) {
            download = candidate
            break
          }
        }
        if (download === null) continue
        const wrap = download.parentElement
        if (wrap === null || wrap.parentElement === null) continue
        const cloned = wrap.cloneNode(true)
        if (!(cloned instanceof HTMLElement)) continue
        const button = cloned.querySelector('button[role="menuitem"]')
        if (!(button instanceof HTMLElement)) continue
        cloned.setAttribute(MENU_ITEM_ATTR, '')
        button.removeAttribute('aria-haspopup')
        button.removeAttribute('aria-expanded')
        button.disabled = false
        const spans = button.querySelectorAll('span')
        // A menu item with an icon has [icon, label]; one without has [label].
        if (spans.length >= 2) spans[0].innerHTML = MORE_ICON_SVG
        const label = spans[spans.length - 1]
        if (label !== undefined) label.textContent = importLabelFor(download.textContent)
        button.addEventListener('click', () => {
          closeOpenMenu()
          window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: {} }))
        })
        wrap.parentElement.insertBefore(cloned, wrap.nextSibling)
        return true
      }
      return false
    }

    /** Re-label any injected item after a locale switch. */
    function refreshInjectedLabel() {
      for (const item of document.querySelectorAll('[' + MENU_ITEM_ATTR + ']')) {
        const spans = item.querySelectorAll('span')
        const label = spans[spans.length - 1]
        if (label !== undefined) label.textContent = translate('action.label')
      }
    }

    /**
     * Keep the injected item present for as long as the plugin is mounted.
     *
     * The scan is driven by the menu's own insertion rather than by a blanket
     * body observer, so streaming conversation updates cost nothing: a mutation
     * only triggers work when the added subtree contains a `[role="menu"]`.
     * @returns the disposer that disconnects the observer and removes injected nodes.
     */
    function watchMoreMenu() {
      const scan = () => {
        try {
          injectMoreMenuItem()
        } catch {
          // Never let a markup change in another plugin break the host UI.
        }
      }
      scan()
      if (typeof MutationObserver !== 'function' || document.body === null) return () => { }
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue
            if (node.matches('[role="menu"]') || node.querySelector('[role="menu"]') !== null) {
              scan()
              return
            }
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        for (const item of document.querySelectorAll('[' + MENU_ITEM_ATTR + ']')) item.remove()
      }
    }

    // --- host calls -----------------------------------------------------------

    /**
     * POST one import request and decode the Host's JSON answer.
     * @param url - request URL including query parameters.
     * @param init - fetch options.
     * @returns the decoded payload.
     */
    async function postImport(url, init) {
      const response = await fetch(url, init)
      let payload = {}
      try {
        payload = await response.json()
      } catch {
        // A non-JSON body means the route answered outside its contract.
      }
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error || `HTTP ${response.status}`)
      }
      return payload
    }

    /** Ask the client list store to re-read the Host's session list. */
    async function refreshSessionList() {
      const service = sessionsService
      if (!service) return
      try {
        if (typeof service.refresh === 'function') await service.refresh()
        else if (typeof service.refreshList === 'function') await service.refreshList()
      } catch {
        // A failed refresh only means the row appears after the next reload.
      }
    }

    /**
     * The session the user currently has open, sent with every request so that
     * `workspace=current` resolves to *this* session's workspace on the Host
     * instead of falling back to the Host process's own working directory.
     *
     * There is no single field for "the open session". Older list snapshots
     * carried `current` directly; the current shell drops that field and defines
     * the open session as the one its main view is holding — the same rule
     * `UiSession` applies to pick its own Session binding (`retainedBy.mainView
     * > 0`), read here through the public list snapshot.
     * @returns the current session id, or undefined when nothing is selected.
     */
    function currentSessionId() {
      try {
        const snapshot = sessionsService && sessionsService.list ? sessionsService.list.getSnapshot() : undefined
        if (snapshot === undefined || snapshot === null) return undefined
        if (typeof snapshot.current === 'string' && snapshot.current !== '') return snapshot.current
        const rows = snapshot.byId
        if (rows === undefined || rows === null) return undefined
        const ids = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(rows)
        for (const id of ids) {
          const row = rows[id]
          if (row === undefined || row === null) continue
          const retainedBy = row.retainedBy
          if (retainedBy !== undefined && retainedBy !== null && (retainedBy.mainView ?? 0) > 0) return id
        }
        return undefined
      } catch {
        return undefined
      }
    }

    // --- dialog ---------------------------------------------------------------

    /**
     * Shared import dialog: file picker, drop zone, host-path fallback, target
     * workspace, and a result summary with a direct "open session" action.
     * @param props - slot props; the dialog is session-agnostic.
     * @returns the modal element, or null while closed.
     */
    function ImportDialog(props) {
      const t = (props && props.t) || translate
      useLocaleRevision()
      const [open, setOpen] = useState(false)
      const [file, setFile] = useState(null)
      const [hostPath, setHostPath] = useState('')
      const [workspace, setWorkspace] = useState('auto')
      const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
      const [dragging, setDragging] = useState(false)
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const fileInput = useRef(null)

      useEffect(() => {
        const handler = (event) => {
          const detail = (event && event.detail) || {}
          setOpen(true)
          setFile(null)
          setHostPath('')
          setWorkspace(detail.workspace || 'auto')
          setWorkspaceMenuOpen(false)
          setResult(null)
          setError(null)
          setBusy(false)
        }
        window.addEventListener(OPEN_EVENT, handler)
        return () => window.removeEventListener(OPEN_EVENT, handler)
      }, [])

      const close = useCallback(() => {
        if (busy) return
        setOpen(false)
        setResult(null)
        setError(null)
      }, [busy])

      const acceptFile = useCallback((candidate) => {
        if (!candidate) return
        if (!/\.zip$/iu.test(String(candidate.name || ''))) {
          setError(translate('dialog.invalidFile'))
          setFile(null)
          return
        }
        if (typeof candidate.size === 'number' && candidate.size > UPLOAD_WARN_BYTES) {
          setError(translate('dialog.tooLarge'))
          setFile(null)
          return
        }
        setError(null)
        setFile(candidate)
      }, [])

      const run = useCallback(async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        setResult(null)
        try {
          const query = new URLSearchParams({ workspace })
          const sessionId = currentSessionId()
          if (sessionId !== undefined) query.set('sessionId', sessionId)
          let payload
          if (hostPath.trim() !== '') {
            query.set('path', hostPath.trim())
            payload = await postImport(`${IMPORT_PATH}?${query.toString()}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ workspace }),
            })
          } else {
            if (file === null) {
              setBusy(false)
              setError(translate('dialog.invalidFile'))
              return
            }
            const body = await file.arrayBuffer()
            payload = await postImport(`${IMPORT_PATH}?${query.toString()}`, {
              method: 'POST',
              headers: { 'content-type': 'application/zip' },
              body,
            })
          }
          setResult(payload)
          setBusy(false)
          await refreshSessionList()
        } catch (reason) {
          setBusy(false)
          const detail = reason && reason.message ? reason.message : String(reason)
          setError(`${translate('dialog.networkFailed')}${detail}`)
        }
      }, [busy, file, hostPath, workspace])

      const openImported = useCallback(() => {
        const id = result && result.rootSessionId
        const service = sessionsService
        if (id && service && typeof service.open === 'function') {
          try {
            service.open(id)
          } catch {
            // The row may need a reload before it is addressable.
          }
        }
        setOpen(false)
      }, [result])

      if (!open) return null

      const summaryLines = []
      if (result) {
        const importedCount = Array.isArray(result.imported) ? result.imported.length : 0
        const workspace = result.workspace || {}
        if (result.alreadyImported === true || importedCount === 0) summaryLines.push(t('dialog.alreadyPresent'))
        else summaryLines.push(`${t('dialog.done')} — ${importedCount}`)
        // The workspace line says what happened, not just where: an existing
        // session cannot be moved between workspaces, a "current workspace" that
        // could not be resolved is reported as the fallback it is, and a session
        // the registry refused to account for says why instead of leaving the
        // row in "Ungrouped" with no explanation.
        if (workspace.grouped === true) summaryLines.push(`${t('dialog.group')}${workspace.path}`)
        else if (workspace.unchanged === true) summaryLines.push(t('dialog.workspaceUnchanged'))
        else if (result.plan && result.plan.targetCwdSource === 'process') summaryLines.push(`${t('dialog.workspaceFallback')}${result.plan.targetCwd}`)
        else if (typeof workspace.reason === 'string' && workspace.reason !== '') {
          summaryLines.push(`${t('dialog.group')}${t('dialog.groupNone')}`)
          summaryLines.push(`${t('dialog.groupNoneReason')}${workspace.reason}`)
        }
        else summaryLines.push(`${t('dialog.group')}${t('dialog.groupNone')}`)
        if (result.attachments) {
          const restored = result.attachments.restored || 0
          const failed = result.attachments.failed || 0
          if (restored > 0 || failed > 0) summaryLines.push(`${t('dialog.attachments')}${restored}/${restored + failed}`)
        }
        if (Array.isArray(result.skipped) && result.skipped.length > 0) {
          summaryLines.push(`${t('dialog.skipped')}${result.skipped.length}`)
        }
        for (const warning of result.warnings || []) summaryLines.push(`• ${warning}`)
        for (const problem of result.errors || []) summaryLines.push(`• ${problem}`)
      }

      const footer = []
      if (result === null) {
        footer.push(React.createElement('button', {
          key: 'cancel',
          type: 'button',
          disabled: busy,
          onClick: close,
          style: {
            padding: '6px 14px',
            marginRight: 8,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary, inherit)',
            fontSize: 13,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.5 : 1,
          },
        }, t('dialog.cancel')))
        footer.push(React.createElement(Button, {
          key: 'import',
          variant: 'primary',
          disabled: busy,
          onClick: run,
        }, busy ? t('dialog.importing') : t('dialog.import')))
      } else {
        if (result.rootSessionId) {
          footer.push(React.createElement(Button, {
            key: 'open',
            variant: 'primary',
            onClick: openImported,
          }, t('dialog.openSession')))
        }
        footer.push(React.createElement('button', {
          key: 'close',
          type: 'button',
          onClick: close,
          style: {
            padding: '6px 14px',
            marginLeft: 8,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary, inherit)',
            fontSize: 13,
            cursor: 'pointer',
          },
        }, t('dialog.close')))
      }

      const body = [
        React.createElement('div', {
          key: 'drop',
          style: dragging ? dropActiveStyle : dropStyle,
          onClick: () => fileInput.current && fileInput.current.click(),
          onDragOver: (event) => {
            event.preventDefault()
            setDragging(true)
          },
          onDragLeave: () => setDragging(false),
          onDrop: (event) => {
            event.preventDefault()
            setDragging(false)
            const dropped = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null
            acceptFile(dropped)
          },
        }, [
          React.createElement(ProjectAddIcon, { key: 'icon', size: 20 }),
          React.createElement('span', { key: 'text' }, file === null ? t('dialog.drop') : `${t('dialog.selected')}${file.name}`),
        ]),
        React.createElement('input', {
          key: 'picker',
          ref: fileInput,
          type: 'file',
          accept: '.zip,application/zip',
          style: { display: 'none' },
          onChange: (event) => acceptFile(event.target.files && event.target.files[0]),
        }),
        React.createElement('label', { key: 'pathLabel', style: fieldStyle }, t('dialog.pathLabel')),
        React.createElement('div', { key: 'path', style: fieldSpacingStyle },
          React.createElement(Input, {
            type: 'text',
            value: hostPath,
            placeholder: t('dialog.pathPlaceholder'),
            disabled: busy,
            onChange: (event) => setHostPath(event.target.value),
          })),
        React.createElement('label', { key: 'wsLabel', style: fieldStyle }, t('dialog.workspace')),
        React.createElement('div', { key: 'workspace', style: fieldSpacingStyle }, [
          React.createElement(Menu, {
            key: 'menu',
            open: workspaceMenuOpen,
            align: 'start',
            dense: true,
            // A portal keeps the list out of the dialog's clipping context and
            // clamps it to the viewport, so no option can be cut off.
            portal: true,
            onClose: () => setWorkspaceMenuOpen(false),
            items: WORKSPACE_POLICIES.map((policy) => ({ id: policy.id, label: workspaceText(policy.id, 'label', t) })),
            onSelect: (id) => {
              setWorkspaceMenuOpen(false)
              if (typeof id === 'string' && id !== '') setWorkspace(id)
            },
            anchor: React.createElement(Button, {
              variant: 'outline',
              disabled: busy,
              style: workspaceTriggerStyle,
              'aria-haspopup': 'menu',
              'aria-expanded': workspaceMenuOpen,
              'aria-label': t('dialog.workspace'),
              onClick: () => setWorkspaceMenuOpen((value) => !value),
            }, [
              React.createElement('span', { key: 'label' }, workspaceText(workspace, 'label', t)),
              React.createElement(ChevronDownIcon, { key: 'chevron' }),
            ]),
          }),
          React.createElement('div', { key: 'hint', style: hintStyle }, workspaceText(workspace, 'hint', t)),
        ]),
        summaryLines.length > 0 ? React.createElement('div', { key: 'status', style: statusStyle }, summaryLines.join('\n')) : null,
        error !== null ? React.createElement('div', { key: 'error', style: errorStyle, role: 'alert' }, error) : null,
      ]

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: result === null ? t('dialog.title') : t('dialog.done'),
        description: t('dialog.description'),
        closeLabel: t('dialog.close'),
        footer,
      }, body)
    }

    // --- entry points ---------------------------------------------------------

    /**
     * Sidebar footer action: the always-reachable import trigger. `wide` is the
     * shell's expanded-column flag, so the control degrades to its icon alone in
     * the collapsed rail.
     * @param props - slot props carrying `wide`.
     * @returns the trigger element.
     */
    function ImportFooterAction(props) {
      const t = (props && props.t) || translate
      useLocaleRevision()
      const wide = props && props.wide === true
      const open = useCallback(() => {
        window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: {} }))
      }, [])
      return React.createElement('button', {
        type: 'button',
        title: t('action.title'),
        'aria-label': t('action.title'),
        style: wide ? footerButtonStyle : { ...footerButtonStyle, justifyContent: 'center', padding: 6 },
        onClick: open,
        onMouseEnter: (event) => {
          event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))'
        },
        onMouseLeave: (event) => {
          event.currentTarget.style.background = 'transparent'
        },
      }, [
        React.createElement(ProjectAddIcon, { key: 'icon', size: 16 }),
        wide ? React.createElement('span', { key: 'label' }, t('action.label')) : null,
      ])
    }

    // --- apply ----------------------------------------------------------------

    /** Adopt the locale service and register this plugin's dictionaries. */
    function adoptLocale(locale, ctx) {
      if (!locale) return
      localeService = locale
      try {
        if (typeof locale.register === 'function') ctx.effect(() => locale.register(NS, { zh, en }))
      } catch {
        // A duplicate namespace keeps the existing copy rather than failing.
      }
    }

    /**
     * Mount the import triggers and their shared dialog.
     * @param ctx - browser context carrying slots (and, when mounted, sessions and locale).
     */
    function apply(ctx) {
      sessionsService = ctx.get('sessions')
      if (!sessionsService) {
        ctx.inject(['sessions'], (sub) => {
          sessionsService = sub.sessions
        })
      }
      adoptLocale(ctx.get('locale'), ctx)
      if (!localeService) {
        ctx.inject(['locale'], (sub) => adoptLocale(sub.locale, ctx))
      }
      ctx.slots.inject(FOOTER_SLOT, () => ctx.slots.register({
        name: FOOTER_SLOT,
        id: 'session-importer',
        order: 40,
        ...(localeService ? { locale: NS } : {}),
      }, ImportFooterAction))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: 'session-importer-dialog',
        order: 120,
        ...(localeService ? { locale: NS } : {}),
      }, ImportDialog))
      // The header menu is another plugin's DOM, so the observer is owned by this
      // plugin's fiber and every injected node is removed on disposal.
      ctx.effect(() => watchMoreMenu(), 'session-importer: header menu item')
      ctx.on('locale/change', refreshInjectedLabel)
    }

    // `slots` gates apply(); the sessions and locale services are optional.
    return { apply, inject: ['slots'] }
  },
})
