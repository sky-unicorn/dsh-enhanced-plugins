import type { ButtonHTMLAttributes, ReactElement, ReactNode, SVGProps } from 'react'

/** Lightweight stand-in for the public edit icon. */
export function IconEditOutline16(props: SVGProps<SVGSVGElement>) {
  return <svg aria-hidden {...props} />
}

export function IconCheckOutline16(props: SVGProps<SVGSVGElement>) {
  return <svg aria-hidden {...props} />
}

export function IconCopyOutline16(props: SVGProps<SVGSVGElement>) {
  return <svg aria-hidden {...props} />
}

export function IconLoadingOutline16(props: SVGProps<SVGSVGElement>) {
  return <svg aria-hidden {...props} />
}

export function IconSendOutline16(props: SVGProps<SVGSVGElement>) {
  return <svg aria-hidden {...props} />
}

export function Button({ children, icon, ...props }: {
  children?: ReactNode
  icon?: ReactNode
  variant?: string
  size?: string
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, ...buttonProps } = props
  return <button type="button" className={className} {...buttonProps}>{icon}{children}</button>
}

/** Focused tests only need Tooltip to preserve its interactive child. */
export function Tooltip({ children }: { children: ReactElement }) {
  return children
}

// Exercise the real target-version reference projection while keeping unrelated controls lightweight.
export { projectUserText } from '@dsh-test/user-text'

export function FileTypeIcon({ path: _path, ...props }: SVGProps<SVGSVGElement> & { path: string }) {
  return <svg aria-hidden {...props} />
}

export function fileSizeText(bytes: number) {
  return `${bytes}B`
}

export function JsonBlock({ label, payload }: { label: string; payload: unknown }) {
  return <span>{label}:{JSON.stringify(payload)}</span>
}

export function writeClipboard(): Promise<boolean> {
  return Promise.resolve(true)
}
