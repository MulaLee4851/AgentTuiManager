// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MotionPresence from '../../src/MotionPresence'
import AnimatedCollapse from '../../src/AnimatedCollapse'
import AnimatedDetails from '../../src/AnimatedDetails'
import CollapsiblePanel from '../../src/CollapsiblePanel'
import { UI_MOTION } from '../../src/ui-motion'

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('shared UI motion', () => {
  it('mounts actionable content immediately and releases interaction before exit completes', () => {
    vi.useFakeTimers()
    const onAction = vi.fn()
    const child = <button onClick={onAction}>Synthetic action</button>
    const { container, rerender } = render(<MotionPresence open={false}>{null}</MotionPresence>)
    rerender(<MotionPresence open>{child}</MotionPresence>)
    fireEvent.click(screen.getByRole('button', { name: 'Synthetic action' }))
    expect(onAction).toHaveBeenCalledOnce()
    rerender(<MotionPresence open={false}>{null}</MotionPresence>)
    expect(container.querySelector('.motion-presence')).toHaveAttribute('inert')
    expect(screen.queryByRole('button', { name: 'Synthetic action' })).not.toBeInTheDocument()
    expect(container.querySelector('button')).toHaveTextContent('Synthetic action')
    act(() => { vi.advanceTimersByTime(UI_MOTION.exit) })
    expect(container.querySelector('button')).toBeNull()
  })

  it('cancels stale removal when a surface is reopened during its exit', () => {
    vi.useFakeTimers()
    const onAction = vi.fn()
    const { container, rerender } = render(<MotionPresence open><button>First action</button></MotionPresence>)
    rerender(<MotionPresence open={false}>{null}</MotionPresence>)
    act(() => { vi.advanceTimersByTime(UI_MOTION.exit / 2) })
    rerender(<MotionPresence open><button onClick={onAction}>New action</button></MotionPresence>)
    expect(container.querySelector('.motion-presence')).not.toHaveAttribute('inert')
    act(() => { vi.advanceTimersByTime(UI_MOTION.exit) })
    fireEvent.click(screen.getByRole('button', { name: 'New action' }))
    expect(onAction).toHaveBeenCalledOnce()
  })

  it('does not retain a closing surface when reduced motion is preferred', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: true })) })
    const { container, rerender } = render(<MotionPresence open><button>Synthetic action</button></MotionPresence>)
    rerender(<MotionPresence open={false}>{null}</MotionPresence>)
    expect(container.querySelector('button')).toBeNull()
  })

  it('preserves collapsed form drafts and makes them inert immediately', () => {
    function Draft(): JSX.Element {
      const [value, setValue] = useState('')
      return <input aria-label='Synthetic draft' value={value} onChange={event => setValue(event.target.value)} />
    }
    const { container, rerender } = render(<AnimatedCollapse open><Draft /></AnimatedCollapse>)
    fireEvent.change(screen.getByRole('textbox', { name: 'Synthetic draft' }), { target: { value: 'unsaved' } })
    rerender(<AnimatedCollapse open={false}><Draft /></AnimatedCollapse>)
    expect(container.firstElementChild).toHaveAttribute('inert')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    rerender(<AnimatedCollapse open><Draft /></AnimatedCollapse>)
    expect(screen.getByRole('textbox', { name: 'Synthetic draft' })).toHaveValue('unsaved')
    expect(container.firstElementChild).not.toHaveAttribute('inert')
  })

  it('updates disclosure accessibility and allows its actions without waiting for expansion', () => {
    const onAction = vi.fn()
    render(<AnimatedDetails title='Synthetic details'><button onClick={onAction}>Run synthetic action</button></AnimatedDetails>)
    const trigger = screen.getByRole('button', { name: 'Synthetic details' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Run synthetic action' })).not.toBeInTheDocument()
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Run synthetic action' }))
    expect(onAction).toHaveBeenCalledOnce()
    fireEvent.click(trigger)
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toHaveAttribute('inert')
  })

  it('removes a hidden Agent panel from keyboard interaction immediately while retaining its children', () => {
    const { container } = render(<CollapsiblePanel name='Agent 列表' storageId='agents'><button>Synthetic Agent</button></CollapsiblePanel>)
    fireEvent.mouseEnter(container.querySelector('.collapsible-panel')!)
    fireEvent.click(screen.getByRole('button', { name: '隐藏Agent 列表' }))
    const surface = container.querySelector('.panel-surface')!
    expect(surface).toHaveAttribute('inert')
    expect(surface).toHaveAttribute('aria-hidden', 'true')
    expect(surface.querySelector('button')).not.toBeNull()
    const handle = screen.getByRole('button', { name: '展开Agent 列表' })
    fireEvent.click(handle)
    expect(surface).not.toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'Synthetic Agent' })).toBeInTheDocument()
  })
})
