export type OverviewArrangement = 'grid' | 'free'

export default function OverviewLayoutControls({ value, onChange, onArrange }: {
  value: OverviewArrangement
  onChange: (value: OverviewArrangement) => void
  onArrange: () => void
}): JSX.Element {
  return <div className='overview-layout-controls'>
    <label>排列方式<select aria-label='总览排列方式' value={value} onChange={event => onChange(event.target.value as OverviewArrangement)}>
      <option value='grid'>网格排列</option><option value='free'>自由排列</option>
    </select></label>
    {value === 'free' && <button type='button' className='button-secondary button-compact' title='将当前可见窗口重新平铺，重置它们的位置和大小' onClick={onArrange}>整理窗口</button>}
  </div>
}
