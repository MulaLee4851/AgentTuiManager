import { type ReactNode, useId, useState } from 'react'
import AnimatedCollapse from './AnimatedCollapse'

export default function AnimatedDetails({ title, className = '', children }: { title: string; className?: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <section className={className}>
    <button type='button' className='animated-details-trigger' aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span className='collapse-chevron' aria-hidden='true'>›</span>{title}
    </button>
    <AnimatedCollapse open={open} id={id}>{children}</AnimatedCollapse>
  </section>
}
