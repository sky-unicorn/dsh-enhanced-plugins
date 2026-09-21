import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { NS } from './locales.ts'
import { Conversation, type Injected } from './Views.tsx'
import { CollaborationIcon } from './Controls.tsx'
import css from './Router.module.css'

/** Render only visible tabs; session switches and hide dispose polling. */
export function SidebarDetails(props: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS> & Injected & { useTabInfo: UseSidebarRightTabInfo }) {
  const { tab } = props.useTabInfo()
  return tab.visible ? <div className={css.sidebar}><Conversation key={props.sessionId} {...props} embedded onDetailsClose={() => tab.actions.close()}/></div> : null
}
export function SidebarTitle({ t }: PropsLocale<typeof NS>) {
  return <span className={css.heading}><CollaborationIcon/>{t('title')}</span>
}
