// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { externalWebUrl } from '../../src/shared/external-url'
import { preventExternalFileDrop } from '../../src/shared/prevent-file-drop'

describe('external navigation policy', () => {
  it('allows only HTTP(S) URLs without embedded credentials', () => {
    expect(externalWebUrl('https://example.com/docs?q=1')).toBe('https://example.com/docs?q=1')
    expect(externalWebUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/')
    for (const value of ['file:///C:/demo.txt', 'javascript:alert(1)', 'data:text/html,test', 'ms-settings:test', 'https://user:pass@example.com', 'https://example.com/\nnext', undefined]) {
      expect(externalWebUrl(value)).toBeUndefined()
    }
  })

  it('blocks OS file drags without changing internal card drags', () => {
    const event = { dataTransfer: { types: ['Files'], files: [], dropEffect: 'copy' }, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }
    preventExternalFileDrop(event as unknown as DragEvent)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(event.dataTransfer.dropEffect).toBe('none')
    event.preventDefault.mockClear()
    event.dataTransfer.types = ['text/plain']
    preventExternalFileDrop(event as unknown as DragEvent)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
