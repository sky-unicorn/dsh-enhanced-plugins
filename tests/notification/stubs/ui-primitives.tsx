import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react'

export function FishLogo(props: SVGProps<SVGSVGElement> & { size?: number }) {
  const { size = 24, ...rest } = props
  return <svg width={size} height={size} {...rest} />
}

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string
  size?: string
  icon?: ReactNode
}) {
  const { variant: _variant, size: _size, icon, children, type = 'button', ...rest } = props
  return <button type={type} {...rest}>{icon}{children}</button>
}
