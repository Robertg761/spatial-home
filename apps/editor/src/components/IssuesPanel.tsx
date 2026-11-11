import type { HomeLayout, LayoutIssue } from '@spatial-home/home-model';
import type { Selection } from '../editor/state.ts';

interface IssuesPanelProps {
  issues: LayoutIssue[];
  layout: HomeLayout;
  onSelect: (selection: Selection) => void;
}

/** Problems the layout's validation found, each linking to the item it's about. */
export function IssuesPanel({ issues, layout, onSelect }: IssuesPanelProps) {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  return (
    <section className="issues">
      <h2>
        Checks{' '}
        <span className="muted">
          {issues.length === 0
            ? 'all good'
            : [count(errors, 'error'), count(warnings, 'warning')].filter(Boolean).join(', ')}
        </span>
      </h2>
      {issues.length > 0 && (
        <ul>
          {issues.map((issue, index) => {
            const selection = selectionForIssue(layout, issue);
            return (
              <li key={index} className={`issue issue-${issue.severity}`}>
                <button
                  type="button"
                  disabled={!selection}
                  onClick={() => selection && onSelect(selection)}
                >
                  {issue.message}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The item an issue is about, from its path into the layout. */
export function selectionForIssue(layout: HomeLayout, issue: Pick<LayoutIssue, 'path'>): Selection {
  const [collection, index] = issue.path;
  if (typeof index !== 'number') return null;
  if (collection === 'rooms') {
    const room = layout.rooms[index];
    return room ? { kind: 'room', id: room.id } : null;
  }
  if (collection === 'openings') {
    const opening = layout.openings[index];
    return opening ? { kind: 'opening', id: opening.id } : null;
  }
  if (collection === 'fixtures') {
    const fixture = layout.fixtures[index];
    return fixture ? { kind: 'fixture', id: fixture.id } : null;
  }
  if (collection === 'devices') {
    const device = layout.devices[index];
    return device ? { kind: 'device', id: device.id } : null;
  }
  return null;
}

function count(n: number, noun: string): string {
  return n === 0 ? '' : `${n} ${noun}${n === 1 ? '' : 's'}`;
}
