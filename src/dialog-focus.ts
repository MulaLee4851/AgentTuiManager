import type { KeyboardEvent } from 'react'

export function trapDialogTab(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (event.key !== 'Tab' || !dialog) return
  const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')]
  const first = controls[0], last = controls.at(-1)
  if (!first) { event.preventDefault(); dialog.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus() }
}
