/** Three model nodes around one task. Decorative; callers own accessible text. */
export function CollaborationIcon({ className }: { className?: string } = {}) {
  return <svg className={className} aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><path d="M7.2 8.1 10 10.8m4 0 2.8-2.7M12 14.5v3"/><rect x="2.5" y="2.5" width="6" height="6" rx="1.8"/><rect x="15.5" y="2.5" width="6" height="6" rx="1.8"/><rect x="9" y="17.5" width="6" height="4" rx="1.5"/><circle cx="12" cy="12.5" r="2"/></svg>
}
