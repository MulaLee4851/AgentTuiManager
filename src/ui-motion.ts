/** Shared with the CSS variables installed on the app root. No animation gates application actions. */
export const UI_MOTION = { enter: 120, exit: 100, expand: 160, feedback: 90 } as const
export const motionVariables = Object.fromEntries(Object.entries(UI_MOTION).map(([name, ms]) => [`--motion-${name}`, `${ms}ms`]))
export function reducedMotion(): boolean { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false }
