/**
 * Web UI half of the AI Web Novel Composer.
 *
 * One surface: a right-Sidebar tab that shows the composer's state for the
 * current session. It registers through exactly the two-stage public path every
 * sidebar tab type uses — the type into `ctx.sidebarRightTabs`, the body into
 * the `sidebar.right.pane.tab` seat — so it is an ordinary tab: dockable,
 * splittable, floatable, and closable.
 *
 * The tab is a *page* type (it names no resource `patterns`), so it is opened by
 * kind from the sidebar's guide page rather than by opening a file address.
 *
 * Data arrives through the same read-only remote the file preview uses
 * (`ctx.remote.workspaceFiles`), which resolves the session's workspace root on
 * the host — so the panel never guesses where the project lives.
 *
 * @module @ai-webnovel/composer-host/client
 */

import { useCallback, useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Side-effect type imports: each contributes the augmentation this module needs —
// `ctx.slots` / `ctx.remote` on `Context`, the sidebar services and slot map
// entry, and the session standard props carrying `sessionId`.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {
  SidebarRightTabDefinition,
  SidebarRightTabInjected,
  UseSidebarRightTabInfo,
} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import { parseNovel } from '../core/novel.ts'
import type { Chapter, NovelState } from '../core/types.ts'
import { NOVEL_RELATIVE_PATH } from '../host/store.ts'

/** Stable client plugin name. */
export const name = 'ai-webnovel-composer-client'

/**
 * Browser services required before the tab can register.
 *
 * `remote` and `remote.workspaceFiles` carry the read-only file access the panel
 * uses; both are provided by the Remote assembly this bundle declares in
 * `dsh.client.inject`.
 */
export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']

/** Unique identity of this tab type within the tab system. */
export const COMPOSER_TAB_ID = 'ai-webnovel-composer/composer'

/** The kind `openTab` names to open this composer page. */
export const COMPOSER_TAB_KIND = 'ai-webnovel-composer'

/** Copy for the tab chip until a live title registration replaces it. */
export const COMPOSER_TAB_TITLE = 'Novel Composer'

/** Slot key this tab body registers into. */
const PANE_TAB_SLOT = 'sidebar.right.pane.tab'

/** What the panel knows about the project it is showing. */
type ProjectRead =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'ready'; state: NovelState }
  | { status: 'error'; message: string }

/** Palette kept local so the panel carries no dependency on the design system. */
const STYLE = {
  root: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', fontSize: '12px' },
  h2: { margin: '0 0 4px', fontSize: '13px', fontWeight: 600 },
  h3: { margin: '12px 0 4px', fontSize: '12px', fontWeight: 600 },
  dim: { opacity: 0.7, lineHeight: 1.55 },
  meta: { opacity: 0.6, fontSize: '11px', lineHeight: 1.5 },
  chapter: { display: 'flex', gap: '6px', alignItems: 'baseline', lineHeight: 1.6 },
  index: { opacity: 0.55, minWidth: '20px', textAlign: 'right' as const },
  badge: { opacity: 0.6, fontSize: '10px', textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  button: {
    alignSelf: 'flex-start' as const,
    marginTop: '4px',
    padding: '3px 8px',
    fontSize: '11px',
    borderRadius: '4px',
    border: '1px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  error: { color: 'var(--dsh-color-danger, #d9534f)', lineHeight: 1.5, whiteSpace: 'pre-wrap' as const },
} as const

/** The Remote face captured at activation; the slot props do not carry services. */
let clientRemote: ClientContext['remote']

/**
 * Read the project document for one session.
 *
 * The host resolves the workspace root from the session identity, so this asks
 * for a workspace-relative path and never names a root itself.
 *
 * @param remote - the client Remote face.
 * @param sessionId - the session whose workspace to read.
 * @param signal - aborted when the tab closes or the session switches.
 * @returns nothing, the project, or a message explaining why it could not be read.
 */
async function readProject(
  remote: ClientContext['remote'],
  sessionId: string,
  signal: AbortSignal,
): Promise<ProjectRead> {
  let result: Awaited<ReturnType<ClientContext['remote']['workspaceFiles']['read']>>
  try {
    result = await remote.workspaceFiles.read(sessionId, NOVEL_RELATIVE_PATH, {}, signal)
  } catch (error) {
    // A transport fault is not "no project": say so rather than showing the
    // onboarding copy, which would invite the user to start over.
    return { status: 'error', message: error instanceof Error ? error.message : String(error) }
  }
  if (result.ok) {
    try {
      return { status: 'ready', state: parseNovel(result.value.text) }
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }
  const code = result.error.code
  if (code === 'FS_NOT_FOUND' || code === 'FS_NOT_TEXT') return { status: 'none' }
  return { status: 'error', message: `${code}: ${result.error.message}` }
}

/**
 * One chapter row.
 *
 * @param props - the chapter to render.
 * @returns the row.
 */
function ChapterRow({ chapter }: { chapter: Chapter }): React.ReactNode {
  return (
    <div style={STYLE.chapter}>
      <span style={STYLE.index}>{chapter.number}</span>
      <span style={{ flex: 1 }}>{chapter.title || <span style={STYLE.dim}>(untitled)</span>}</span>
      <span style={STYLE.badge}>{chapter.status}</span>
      <span style={STYLE.meta}>{chapter.wordCount}</span>
    </div>
  )
}

/**
 * Render the panel body for whatever the read produced.
 *
 * @param props - the read result and the retry callback.
 * @returns the panel body.
 */
function ProjectBody({ project, onRetry }: { project: ProjectRead; onRetry: () => void }): React.ReactNode {
  if (project.status === 'loading') return <div style={STYLE.dim}>Reading the novel project…</div>

  if (project.status === 'error') {
    return (
      <div>
        <div style={STYLE.error}>{project.message}</div>
        <button type="button" style={STYLE.button} onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  }

  if (project.status === 'none') {
    return (
      <div>
        <p style={STYLE.dim}>
          No novel project in this workspace yet. The composer creates <code>{NOVEL_RELATIVE_PATH}</code> when a session
          starts in an empty or novel directory. Ask the agent to <em>start a novel here</em> and it will call{' '}
          <code>novel_init</code>.
        </p>
        <button type="button" style={STYLE.button} onClick={onRetry}>
          Check again
        </button>
      </div>
    )
  }

  const { state } = project
  const chapters = Object.values(state.chapters).sort((a, b) => a.number - b.number)
  const words = chapters.reduce((total, chapter) => total + chapter.wordCount, 0)
  const unwritten = chapters.filter((chapter) => chapter.body.trim() === '').length

  return (
    <div>
      <div style={{ fontWeight: 600 }}>{state.meta.title || '(untitled)'}</div>
      <p style={STYLE.dim}>{state.meta.premise || 'No premise recorded yet.'}</p>
      <div style={STYLE.meta}>
        {String(chapters.length)} chapters · {String(words)} 字 · {String(unwritten)} unwritten
        <br />
        {String(Object.keys(state.characters).length)} characters · {String(Object.keys(state.world).length)} world facts
        {state.meta.pov ? ` · ${state.meta.pov}` : ''}
        {state.meta.language ? ` · ${state.meta.language}` : ''}
      </div>

      {chapters.length > 0 && (
        <>
          <h3 style={STYLE.h3}>Chapters</h3>
          {chapters.map((chapter) => (
            <ChapterRow key={chapter.id} chapter={chapter} />
          ))}
        </>
      )}

      <button type="button" style={STYLE.button} onClick={onRetry}>
        Refresh
      </button>
    </div>
  )
}

/**
 * The tab body.
 *
 * Reads the enclosing tab's live information through the framework-bound
 * `useTabInfo` hook and the session identity from the session standard props, so
 * a reopened tab, a floated copy, and a second pane all render correctly without
 * per-tab plumbing.
 *
 * @param props - composed slot props: the session identity and the injected hook.
 * @returns the composer panel.
 */
function ComposerTabBody({
  sessionId,
  useTabInfo,
}: ComposedProps<typeof PANE_TAB_SLOT, typeof COMPOSER_TAB_ID, never, undefined, SidebarRightTabInjected>) {
  const info = useTabInfo()
  const [project, setProject] = useState<ProjectRead>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setProject({ status: 'loading' })
    void readProject(clientRemote, sessionId, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setProject(next)
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setProject({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      },
    )
    return () => {
      controller.abort()
    }
  }, [sessionId, attempt])

  const retry = useCallback(() => {
    setAttempt((value) => value + 1)
  }, [])

  return (
    <div style={STYLE.root}>
      <header>
        <h2 style={STYLE.h2}>Novel Composer</h2>
        <div style={STYLE.meta}>
          {info.sidebar.fullscreen ? 'fullscreen' : 'docked'} · pane {String(info.panel.id)}
        </div>
      </header>
      <ProjectBody project={project} onRetry={retry} />
    </div>
  )
}

/**
 * Register the composer tab type and its body.
 *
 * Both registrations are owned by `ctx.effect`, so unloading the plugin removes
 * the tab type and its seat together — a type without a body would render the
 * sidebar's "nothing can view this" notice.
 *
 * @param ctx - client root context carrying the sidebar registries and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  clientRemote = ctx.remote

  const definition: SidebarRightTabDefinition = {
    id: COMPOSER_TAB_ID,
    kind: COMPOSER_TAB_KIND,
    title: () => COMPOSER_TAB_TITLE,
    guide: [
      {
        order: 50,
        title: () => COMPOSER_TAB_TITLE,
        description: () => 'Plan, draft, and track a web novel',
      },
    ],
  }

  ctx.effect(() => {
    const disposeType = ctx.sidebarRightTabs.register(definition)
    const disposeBody = ctx.slots.register(
      {
        name: PANE_TAB_SLOT,
        key: COMPOSER_TAB_ID,
        registrant: COMPOSER_TAB_ID,
        inject: (_standard: unknown, hookContext: { tabInfo: UseSidebarRightTabInfo }) => ({
          hooks: { tabInfo: hookContext.tabInfo },
        }),
      },
      ComposerTabBody,
    )
    return () => {
      disposeBody()
      disposeType()
    }
  })
}
