// Preserve internal Agent card dragging; only OS file drags are blocked.
export function preventExternalFileDrop(event: DragEvent): void {
  const transfer = event.dataTransfer
  if (!transfer || (!Array.from(transfer.types).includes('Files') && !transfer.files.length)) return
  event.preventDefault()
  event.stopImmediatePropagation()
  transfer.dropEffect = 'none'
}
