// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import SessionStatusFilter, { normalizeStatusFilter } from '../../src/SessionStatusFilter'
import type { SessionDisplayStatus } from '../../src/shared/session-state'

afterEach(cleanup)

describe('status multiselect', () => {
  it('migrates legacy values and sanitizes saved selections', () => {
    expect(normalizeStatusFilter('running')).toEqual(['running'])
    expect(normalizeStatusFilter('all')).toEqual([])
    expect(normalizeStatusFilter(['idle', 'needs_approval', 'idle', 'bad', null])).toEqual(['idle', 'needs_approval'])
    expect(normalizeStatusFilter(undefined)).toEqual([])
  })

  it('toggles multiple selections, resets, and closes on Escape and outside click', () => {
    function Harness(): JSX.Element {
      const [value, setValue] = useState<SessionDisplayStatus[]>([])
      return <SessionStatusFilter value={value} onChange={setValue} />
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '筛选 Agent 状态' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('checkbox', { name: '运行中' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '待审批' }))
    expect(trigger).toHaveTextContent('运行中、待审批')
    expect(screen.getByRole('checkbox', { name: '运行中' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '显示全部状态' }))
    expect(trigger).toHaveTextContent('全部状态')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })
})
