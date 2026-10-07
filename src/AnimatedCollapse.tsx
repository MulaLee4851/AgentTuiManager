import type { ReactNode } from 'react'

/** Keep contents mounted for both transition directions, but remove closed controls from interaction. */
export default function AnimatedCollapse({ open, children, id, className = '' }: {
  open: boolean; children: ReactNode; id?: string; className?: string
}): JSX.Element {
  return <div id={id} className={`animated-collapse ${className}`} data-open={open} aria-hidden={!open}
    {...(!open ? { inert: '' } : {})}>
    <div className='animated-collapse-clip'>{children}</div>
  </div>
}
