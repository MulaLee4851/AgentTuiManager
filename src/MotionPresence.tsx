import { type ReactNode, useEffect, useRef, useState } from 'react'
import { reducedMotion, UI_MOTION } from './ui-motion'

/** Mount immediately. Closing releases interaction immediately; only visual removal waits. */
export default function MotionPresence({ open, children }: { open: boolean; children: ReactNode }): JSX.Element | null {
  const [retained, setRetained] = useState(open)
  const lastChildren = useRef(children)
  if (open) lastChildren.current = children
  useEffect(() => {
    if (open) { setRetained(true); return }
    if (reducedMotion()) { setRetained(false); return }
    const timer = setTimeout(() => setRetained(false), UI_MOTION.exit)
    return () => clearTimeout(timer)
  }, [open])
  if (!open && !retained) return null
  return <div className='motion-presence' data-open={open} aria-hidden={!open} {...(!open ? { inert: '' } : {})}>
    {open ? children : lastChildren.current}
  </div>
}
