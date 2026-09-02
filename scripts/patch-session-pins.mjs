/**
 * Adds desktop-owned session pinning to the upstream DSH workspace client.
 *
 * The patch stays in the React data path: no DOM polling, MutationObserver,
 * filesystem scan, background timer, or extra process is introduced.
 *
 * Usage:
 *   node patch-session-pins.mjs <runtimeRoot>
 *   node patch-session-pins.mjs <runtimeRoot> --check
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_PINNED_SESSIONS = 50

export function pinFirstRows(rows, pinnedSessionIds) {
  if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(pinnedSessionIds) || pinnedSessionIds.length === 0) return rows
  const pinned = new Set(pinnedSessionIds)
  const blanks = []
  const pinnedRows = []
  const ordinary = []
  for (const row of rows) {
    if (row?.blank) blanks.push(row)
    else if (pinned.has(row?.id)) pinnedRows.push(row)
    else ordinary.push(row)
  }
  return [...blanks, ...pinnedRows, ...ordinary]
}

const START = '/* DSH_DESKTOP_SESSION_PINS_START */'
const END = '/* DSH_DESKTOP_SESSION_PINS_END */'
const PERSISTENCE = '/* DSH_DESKTOP_SESSION_PINS_PERSISTENCE */'

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle)
  if (first === -1 || source.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`session-pin patch anchor missing or ambiguous: ${label}`)
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + needle.length)}`
}

export function patchWorkspaceClient(source) {
  if (source.includes(PERSISTENCE)) return { source, changed: false }

  const addPersistence = (input) => {
    let persisted = replaceOnce(input,
      '\t\t\t\t\ttogglePinnedSession: (d, sessionId) => {\n\t\t\t\t\t\tconst current = Array.isArray(d.pinnedSessionIds) ? d.pinnedSessionIds : [];\n\t\t\t\t\t\td.pinnedSessionIds = current.includes(sessionId)\n\t\t\t\t\t\t\t? current.filter((id) => id !== sessionId)\n\t\t\t\t\t\t\t: [sessionId, ...current].slice(0, 50);\n\t\t\t\t\t}',
      '\t\t\t\t\treplacePinnedSessions: (d, sessionIds) => {\n\t\t\t\t\t\td.pinnedSessionIds = Array.isArray(sessionIds) ? sessionIds.slice(0, 50) : [];\n\t\t\t\t\t},\n\t\t\t\t\ttogglePinnedSession: (d, sessionId) => {\n\t\t\t\t\t\tconst current = Array.isArray(d.pinnedSessionIds) ? d.pinnedSessionIds : [];\n\t\t\t\t\t\tconst next = current.includes(sessionId)\n\t\t\t\t\t\t\t? current.filter((id) => id !== sessionId)\n\t\t\t\t\t\t\t: [sessionId, ...current].slice(0, 50);\n\t\t\t\t\t\td.pinnedSessionIds = next;\n\t\t\t\t\t\twindow.ccDesktop?.setPinnedSessions(next).catch(() => {});\n\t\t\t\t\t}',
      'persistent store actions')
    persisted = replaceOnce(persisted,
      '\t\t\tconst pinnedSessionIds = useStore((s) => Array.isArray(s.pinnedSessionIds) ? s.pinnedSessionIds : []);',
      '\t\t\tconst pinnedSessionIds = useStore((s) => Array.isArray(s.pinnedSessionIds) ? s.pinnedSessionIds : []);\n\t\t\t' + PERSISTENCE + '\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tlet active = true;\n\t\t\t\twindow.ccDesktop?.getPinnedSessions().then((ids) => {\n\t\t\t\t\tif (active) actions.replacePinnedSessions(ids);\n\t\t\t\t}).catch(() => {});\n\t\t\t\treturn () => { active = false; };\n\t\t\t}, [actions.replacePinnedSessions]);',
      'persistent store hydration')
    return persisted
  }

  if (source.includes(START) && source.includes(END)) {
    return { source: addPersistence(source), changed: true }
  }

  let out = source
  out = replaceOnce(out,
    '\t\t\t\t\tsessionOrderByAccount: {},\n\t\t\t\t\tsessionUpdatedAtByAccount: {}',
    '\t\t\t\t\tsessionOrderByAccount: {},\n\t\t\t\t\tsessionUpdatedAtByAccount: {},\n\t\t\t\t\tpinnedSessionIds: []',
    'store state')

  out = replaceOnce(out,
    '\t\t\t\t\tsetSessionOrder: (d, accountKey, order) => {\n\t\t\t\t\t\td.sessionOrderByAccount[accountKey] = order;\n\t\t\t\t\t}',
    '\t\t\t\t\tsetSessionOrder: (d, accountKey, order) => {\n\t\t\t\t\t\td.sessionOrderByAccount[accountKey] = order;\n\t\t\t\t\t},\n\t\t\t\t\ttogglePinnedSession: (d, sessionId) => {\n\t\t\t\t\t\tconst current = Array.isArray(d.pinnedSessionIds) ? d.pinnedSessionIds : [];\n\t\t\t\t\t\td.pinnedSessionIds = current.includes(sessionId)\n\t\t\t\t\t\t\t? current.filter((id) => id !== sessionId)\n\t\t\t\t\t\t\t: [sessionId, ...current].slice(0, 50);\n\t\t\t\t\t}',
    'store action')

  const helper = `${START}\n\t\tconst pinFirstRows = ${pinFirstRows.toString()};\n\t\t${END}\n`
  out = replaceOnce(out,
    '\t\tfunction byRecency(a, b) {\n\t\t\tif (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;\n\t\t\treturn a.id < b.id ? -1 : 1;\n\t\t}\n',
    '\t\tfunction byRecency(a, b) {\n\t\t\tif (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;\n\t\t\treturn a.id < b.id ? -1 : 1;\n\t\t}\n' + helper,
    'ordering helper')

  out = replaceOnce(out,
    '\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, t }) {',
    '\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, pinned, onTogglePinned, drag, flat = false, t }) {',
    'session row props')

  out = replaceOnce(out,
    '\t\t\tconst sessionMenuItems = [\n\t\t\t\t{\n\t\t\t\t\tid: "rename",',
    '\t\t\tconst sessionMenuItems = [\n\t\t\t\t{\n\t\t\t\t\tid: "pin",\n\t\t\t\t\tlabel: t(pinned ? "menu.unpinSession" : "menu.pinSession"),\n\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(SessionPinIcon, {})\n\t\t\t\t},\n\t\t\t\t{\n\t\t\t\t\tid: "rename",',
    'session menu')

  out = replaceOnce(out,
    '\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, pinned, onTogglePinned, drag, flat = false, t }) {',
    '\t\tfunction SessionPinIcon({ size = 16 }) {\n\t\t\treturn (0, react_jsx_runtime.jsx)("svg", {\n\t\t\t\twidth: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",\n\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("path", { d: "M5 2.25h6l-1.1 3.1 1.85 1.85v1.05H8.6V13.5L8 14.25l-.6-.75V8.25H4.25V7.2L6.1 5.35 5 2.25Z", fill: "currentColor" })\n\t\t\t});\n\t\t}\n\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, pinned, onTogglePinned, drag, flat = false, t }) {',
    'pin icon')

  out = replaceOnce(out,
    '\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,\n\t\t\t\t\t\t\tchildren: title\n\t\t\t\t\t\t}),',
    '\t\t\t\t\t\tpinned && (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\t"aria-label": t("pin.pinned"),\n\t\t\t\t\t\t\ttitle: t("pin.pinned"),\n\t\t\t\t\t\t\tstyle: { display: "inline-flex", flex: "none", color: "var(--dsw-alias-state-business-primary)" },\n\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(SessionPinIcon, { size: 12 })\n\t\t\t\t\t\t}),\n\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,\n\t\t\t\t\t\t\tchildren: title\n\t\t\t\t\t\t}),',
    'pin indicator')

  out = replaceOnce(out,
    '\t\t\t\t\t\t\t\t\tif (id === "rename") onRename(node.id, row.title);',
    '\t\t\t\t\t\t\t\t\tif (id === "pin") onTogglePinned(node.id);\n\t\t\t\t\t\t\t\t\tif (id === "rename") onRename(node.id, row.title);',
    'pin selection')

  out = replaceOnce(out,
    '\t\tfunction SessionTree({ useSessions, useSessionPendingInteraction, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t }) {',
    '\t\tfunction SessionTree({ useSessions, useSessionPendingInteraction, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, pinnedSessionIds, togglePinnedSession, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t }) {',
    'tree props')

  out = replaceOnce(out,
    '\t\t\t\t\t\t\t(sessionsExpanded ? group.sessions : collapsed.rows).map((node) => {',
    '\t\t\t\t\t\t\t(sessionsExpanded ? pinFirstRows(group.sessions, pinnedSessionIds) : collapsedSessionRows(pinFirstRows(group.sessions, pinnedSessionIds)).rows).map((node) => {',
    'tree pin ordering')

  out = replaceOnce(out,
    '\t\t\t\t\t\t\t\t\t\t\tonArchive: onSessionArchive,\n\t\t\t\t\t\t\t\t\t\t\tdrag:',
    '\t\t\t\t\t\t\t\t\t\t\tonArchive: onSessionArchive,\n\t\t\t\t\t\t\t\t\t\t\tpinned: pinnedSessionIds.includes(node.id),\n\t\t\t\t\t\t\t\t\t\t\tonTogglePinned: togglePinnedSession,\n\t\t\t\t\t\t\t\t\t\t\tdrag:',
    'tree row pin props')

  out = replaceOnce(out,
    '\t\tfunction FlatList({ useSessions, useSessionPendingInteraction, open, forkSession, onSessionRename, onSessionArchive, archivedSessionIds, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, t }) {',
    '\t\tfunction FlatList({ useSessions, useSessionPendingInteraction, open, forkSession, onSessionRename, onSessionArchive, pinnedSessionIds, togglePinnedSession, archivedSessionIds, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, t }) {',
    'flat props')

  out = replaceOnce(out,
    '\t\t\t\treturn reconciledSessionOrder(sessionIds, sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).flatMap((id) => {\n\t\t\t\t\tconst row = byId.get(id);\n\t\t\t\t\treturn row === void 0 ? [] : [row];\n\t\t\t\t});',
    '\t\t\t\treturn pinFirstRows(reconciledSessionOrder(sessionIds, sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).flatMap((id) => {\n\t\t\t\t\tconst row = byId.get(id);\n\t\t\t\t\treturn row === void 0 ? [] : [row];\n\t\t\t\t}), pinnedSessionIds);',
    'flat pin ordering')

  out = replaceOnce(out,
    '\t\t\t\tbaseRows,\n\t\t\t\tsessionOrderByAccount,\n\t\t\t\tsessionIds\n\t\t\t]);',
    '\t\t\t\tbaseRows,\n\t\t\t\tsessionOrderByAccount,\n\t\t\t\tsessionIds,\n\t\t\t\tpinnedSessionIds\n\t\t\t]);',
    'flat memo dependencies')

  out = replaceOnce(out,
    '\t\t\t\t\t\t\tonArchive: onSessionArchive,\n\t\t\t\t\t\t\tflat: true,',
    '\t\t\t\t\t\t\tonArchive: onSessionArchive,\n\t\t\t\t\t\t\tpinned: pinnedSessionIds.includes(node.id),\n\t\t\t\t\t\t\tonTogglePinned: togglePinnedSession,\n\t\t\t\t\t\t\tflat: true,',
    'flat row pin props')

  out = replaceOnce(out,
    '\t\t\tconst sessionUpdatedAtByAccount = useStore((s) => s.sessionUpdatedAtByAccount);',
    '\t\t\tconst sessionUpdatedAtByAccount = useStore((s) => s.sessionUpdatedAtByAccount);\n\t\t\tconst pinnedSessionIds = useStore((s) => Array.isArray(s.pinnedSessionIds) ? s.pinnedSessionIds : []);',
    'browser store read')

  out = replaceOnce(out,
    '\t\t\t\t\t\t\tonSessionArchive,\n\t\t\t\t\t\t\tarchivedSessionIds,',
    '\t\t\t\t\t\t\tonSessionArchive,\n\t\t\t\t\t\t\tpinnedSessionIds,\n\t\t\t\t\t\t\ttogglePinnedSession: actions.togglePinnedSession,\n\t\t\t\t\t\t\tarchivedSessionIds,',
    'flat browser props')

  out = replaceOnce(out,
    '\t\t\t\t\t\t\tonSessionArchive,\n\t\t\t\t\t\t\tforkSession,\n\t\t\t\t\t\t\tworkspaces,',
    '\t\t\t\t\t\t\tonSessionArchive,\n\t\t\t\t\t\t\tpinnedSessionIds,\n\t\t\t\t\t\t\ttogglePinnedSession: actions.togglePinnedSession,\n\t\t\t\t\t\t\tforkSession,\n\t\t\t\t\t\t\tworkspaces,',
    'tree browser props')

  out = replaceOnce(out,
    '\t\tconst zh = {\n',
    '\t\tconst zh = {\n\t\t\t"menu.pinSession": "置顶会话",\n\t\t\t"menu.unpinSession": "取消置顶",\n\t\t\t"pin.pinned": "已置顶",\n',
    'Chinese locale')

  out = replaceOnce(out,
    '\t\tconst en = {\n',
    '\t\tconst en = {\n\t\t\t"menu.pinSession": "Pin session",\n\t\t\t"menu.unpinSession": "Unpin session",\n\t\t\t"pin.pinned": "Pinned",\n',
    'English locale')

  return { source: addPersistence(out), changed: true }
}

export function patchRuntime(runtimeRoot, checkOnly = false) {
  const target = path.join(path.resolve(runtimeRoot), 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js')
  const original = readFileSync(target, 'utf8')
  const result = patchWorkspaceClient(original)
  if (checkOnly) {
    if (!original.includes(START) || !original.includes(END)) throw new Error('session-pin patch is not installed')
    return { target, changed: false }
  }
  if (!result.changed) return { target, changed: false }
  const temporary = `${target}.session-pins-${process.pid}.tmp`
  try {
    writeFileSync(temporary, result.source, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, target)
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
  return { target, changed: true }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  const runtimeRoot = process.argv[2]
  if (!runtimeRoot) {
    console.error('usage: node patch-session-pins.mjs <runtimeRoot> [--check]')
    process.exitCode = 2
  } else {
    try {
      const result = patchRuntime(runtimeRoot, process.argv[3] === '--check')
      console.log(`${result.changed ? '[patch] installed' : '[check] ready'}: ${result.target}`)
    } catch (error) {
      console.error(`[session-pins] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  }
}
