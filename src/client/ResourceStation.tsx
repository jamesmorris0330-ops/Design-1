import { useEffect, useState } from 'react';
import type { Allocation } from '../shared/protocol';
import './resource-station.css';

type Resource = keyof Allocation;
type Cell = Resource | null;

const resources: Resource[] = ['medical', 'security', 'reserve'];
const labels: Record<Resource, string> = { medical: 'Medical', security: 'Security', reserve: 'Reserve' };
const descriptions: Record<Resource, string> = {
  medical: 'Life support', security: 'Containment', reserve: 'Uncommitted power',
};

function cellsFor(allocation: Allocation): Cell[] {
  const cells: Cell[] = [];
  for (const resource of resources) for (let i = 0; i < allocation[resource]; i++) cells.push(resource);
  while (cells.length < 3) cells.push(null);
  return cells.slice(0, 3);
}

function counts(cells: Cell[]): Allocation {
  return {
    medical: cells.filter(cell => cell === 'medical').length,
    security: cells.filter(cell => cell === 'security').length,
    reserve: cells.filter(cell => cell === 'reserve').length,
  };
}

function sameAllocation(a: Allocation, b: Allocation) {
  return resources.every(resource => a[resource] === b[resource]);
}

function StationMachine({ resource, powered }: { resource: Resource; powered: boolean }) {
  return <svg className={`station-machine ${powered ? 'powered' : ''}`} viewBox="0 0 160 116" fill="none" aria-hidden="true">
    <path className="machine-outline" d="M16 99V28l13-13h102l13 13v71z" />
    <path className="machine-top" d="M29 15v10h102V15M16 99h128v8H16z" />
    <path className="machine-detail" d="M23 30v56m114-56v56M30 96h100" />
    {resource === 'medical' ? <>
      <rect className="machine-screen" x="37" y="34" width="86" height="33" rx="3" />
      <path className="machine-pulse" d="M41 53h15l7-11 8 19 8-23 8 15h31" />
      <path className="machine-detail" d="M45 79h12m-6-6v12M75 75h8v11h-8zm18 0h8v11h-8zm18 0h8v11h-8z" />
    </> : resource === 'security' ? <>
      <path className="machine-shield" d="m80 32 25 10v16c0 17-25 28-25 28S55 75 55 58V42z" />
      <path className="machine-pulse" d="m68 58 8 8 16-19" />
      <path className="machine-detail" d="M35 42h10m-10 8h10m-10 8h10m70-16h10m-10 8h10m-10 8h10" />
    </> : <>
      <rect className="machine-screen" x="42" y="35" width="76" height="48" rx="4" />
      <path className="machine-detail" d="M49 59h62M65 42v34m30-34v34" />
      <circle className="machine-core" cx="80" cy="59" r="13" />
      <path className="machine-pulse" d="m84 49-9 12h9l-7 10" />
    </>}
    <circle className="machine-indicator" cx="31" cy="91" r="2" /><circle className="machine-indicator" cx="38" cy="91" r="2" /><circle className="machine-indicator" cx="45" cy="91" r="2" />
    <path className="machine-detail" d="M114 92h14" />
  </svg>;
}

/** Local, private planning only. The parent still validates and locks the decision. */
export function ResourceStation({ allocation, onChange, disabled, restriction, medicalTarget, securityTarget }: {
  allocation: Allocation;
  onChange: (allocation: Allocation) => void;
  disabled: boolean;
  restriction: boolean;
  medicalTarget: number;
  securityTarget: number;
}) {
  const [cells, setCells] = useState<Cell[]>(() => cellsFor(allocation));
  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const total = allocation.medical + allocation.security + allocation.reserve;

  useEffect(() => {
    setCells(current => sameAllocation(counts(current), allocation) ? current : cellsFor(allocation));
  }, [allocation.medical, allocation.security, allocation.reserve]);

  useEffect(() => { if (disabled) { setSelected(null); setDragging(null); } }, [disabled]);

  const commit = (next: Cell[]) => {
    if (disabled) return;
    setCells(next);
    onChange(counts(next));
  };

  const route = (resource: Resource, cellIndex: number | null = selected) => {
    if (disabled) return;
    const index = cellIndex ?? cells.indexOf(null);
    if (index < 0 || index > 2) return;
    const next = [...cells];
    next[index] = resource;
    commit(next);
    setSelected(null);
    setDragging(null);
  };

  const adjust = (resource: Resource, delta: 1 | -1) => {
    if (disabled) return;
    const next = [...cells];
    const index = delta === 1 ? next.indexOf(null) : next.lastIndexOf(resource);
    if (index < 0) return;
    next[index] = delta === 1 ? resource : null;
    commit(next);
    setSelected(null);
  };

  return <div className={`resource-console ${disabled ? 'console-disabled' : ''}`} data-testid="resource-station">
    <div className="console-caption"><span>YOUR PRIVATE POWER GRID</span><span className="console-security"><span aria-hidden="true">◈</span> LOCAL PREVIEW</span></div>
    <div className="energy-bank">
      <div className="energy-bank-label"><strong>3 energy cells</strong><span>Route your power.</span></div>
      <div className="energy-cells" role="group" aria-label="Your three energy cells">
        {cells.map((cell, index) => <button
          className={`energy-cell ${cell ?? 'unassigned'} ${selected === index ? 'cell-selected' : ''} ${dragging === index ? 'cell-dragging' : ''}`}
          key={index}
          type="button"
          disabled={disabled}
          aria-label={`Energy cell ${index + 1}, ${cell ? `assigned to ${labels[cell]}` : 'unassigned'}`}
          aria-pressed={selected === index}
          title={cell ? `Move this ${labels[cell]} cell to another station` : 'Select this energy cell, then choose a station'}
          onClick={() => setSelected(selected === index ? null : index)}
          draggable={!disabled}
          onDragStart={event => { setDragging(index); setSelected(index); event.dataTransfer.setData('text/plain', String(index)); event.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd={() => setDragging(null)}
        ><span className="cell-cap" /><span className="cell-core"><span /><span /><span /></span><span className="cell-cap" /><span className="cell-number">0{index + 1}</span><span className="cell-assignment">{cell ? labels[cell] : 'READY'}</span></button>)}
      </div>
    </div>
    <p className="routing-instruction" aria-live="polite">{disabled ? 'Your controls are secured.' : selected !== null ? `Cell ${selected + 1} selected. Choose its destination below.` : total < 3 ? 'Tap a station to send power. Select a cell to move it.' : 'All cells routed. Select a cell to redirect its power.'}</p>
    <svg className="power-channels" viewBox="0 0 600 50" preserveAspectRatio="none" aria-hidden="true">
      <path className={allocation.medical > 0 ? 'channel medical active' : 'channel medical'} d="M300 0v15H100v35" />
      <path className={allocation.security > 0 ? 'channel security active' : 'channel security'} d="M300 0v50" />
      <path className={allocation.reserve > 0 ? 'channel reserve active' : 'channel reserve'} d="M300 0v15h200v35" />
      <circle cx="300" cy="15" r="5" />
    </svg>
    <div className="station-grid">
      {resources.map(resource => {
        const title = labels[resource];
        const value = allocation[resource];
        const canRoute = !disabled && (selected !== null || total < 3);
        return <div className={`power-station ${resource} ${value > 0 ? 'station-powered' : ''} ${dragging !== null ? 'station-drop-ready' : ''}`} key={resource}
          onDragOver={event => { if (!disabled && dragging !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
          onDrop={event => { if (!disabled && dragging !== null) { event.preventDefault(); route(resource, dragging); } }}>
          <button className="station-route" type="button" disabled={!canRoute} onClick={() => route(resource)} aria-label={`Route energy cell to ${title}`}>
            <span className="station-visual"><StationMachine resource={resource} powered={value > 0} /><span className="station-glow" /></span>
            <strong>{title}</strong><span className="station-description">{descriptions[resource]}</span>
          </button>
          <div className="station-stepper"><button type="button" aria-label={`Remove ${title} unit`} disabled={disabled || value <= 0} onClick={() => adjust(resource, -1)}>−</button><output aria-label={`${title} allocation`}>{value}</output><button type="button" aria-label={`Add ${title} unit`} disabled={disabled || total >= 3} onClick={() => adjust(resource, 1)}>+</button></div>
          <div className="station-cell-meter" aria-hidden="true">{[0, 1, 2].map(index => <span className={index < value ? 'meter-on' : ''} key={index} />)}</div>
          <p className="station-target">{resource === 'reserve' ? <>No direct<br />Stability effect</> : <>Group threshold<br /><strong>{resource === 'medical' ? medicalTarget : securityTarget} units</strong></>}</p>
        </div>;
      })}
    </div>
    <div className="console-status"><span className={total === 3 ? 'all-routed' : ''}><i aria-hidden="true" />{total === 3 ? 'ALL CELLS ROUTED' : `${3 - total} CELL${3 - total === 1 ? '' : 'S'} AVAILABLE`}</span><span>Others cannot see this grid.</span></div>
    {restriction && <p className={`console-restriction ${allocation.medical >= 1 ? 'restriction-satisfied' : ''}`}>RESTRICTION · Route at least one cell to Medical{allocation.medical >= 1 ? ' · SATISFIED' : ''}.</p>}
  </div>;
}
