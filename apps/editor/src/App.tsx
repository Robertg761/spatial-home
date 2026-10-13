import {
  createEmptyLayout,
  parseLayoutJson,
  validateLayout,
  type HomeLayout,
} from '@spatial-home/home-model';
import sample from '@spatial-home/home-model/examples/sample-flat.json';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Inspector } from './components/Inspector.tsx';
import { IssuesPanel, selectionForIssue } from './components/IssuesPanel.tsx';
import { PlanView, type Tool } from './components/PlanView.tsx';
import { deleteItem } from './editor/plan.ts';
import { editorReducer, initialState, isPristine } from './editor/state.ts';
import { downloadLayout, loadDraft, saveDraft } from './editor/storage.ts';

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'select', label: 'Select', key: 'V' },
  { tool: 'room', label: 'Room', key: 'R' },
  { tool: 'door', label: 'Door', key: 'D' },
  { tool: 'window', label: 'Window', key: 'W' },
  { tool: 'passage', label: 'Passage', key: 'P' },
];

export function App() {
  const [state, dispatch] = useReducer(editorReducer, undefined, () =>
    initialState(loadDraft() ?? createEmptyLayout())
  );
  const [tool, setTool] = useState<Tool>('select');
  const [message, setMessage] = useState('');
  const [fitRequest, setFitRequest] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const validation = useMemo(() => validateLayout(state.layout), [state.layout]);
  const issues = useMemo(
    () => [...(validation.ok ? [] : validation.errors), ...validation.warnings],
    [validation]
  );
  const flagged = useMemo(() => {
    const map = new Map<string, 'error' | 'warning'>();
    for (const issue of issues) {
      const selection = selectionForIssue(state.layout, issue);
      if (selection && map.get(selection.id) !== 'error') map.set(selection.id, issue.severity);
    }
    return map;
  }, [issues, state.layout]);

  // Save the draft shortly after each change rather than on every drag step.
  useEffect(() => {
    const timer = setTimeout(() => saveDraft(state.layout), 400);
    return () => clearTimeout(timer);
  }, [state.layout]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  const load = (layout: HomeLayout, note = '') => {
    dispatch({ type: 'load', layout });
    setTool('select');
    setFitRequest((n) => n + 1);
    setMessage(note);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      } else if (mod) {
        return;
      } else if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        tool === 'select' &&
        state.selection
      ) {
        event.preventDefault();
        dispatch({ type: 'edit', layout: deleteItem(state.layout, state.selection), select: null });
      } else if (event.key === 'Escape' && tool === 'select') {
        dispatch({ type: 'select', selection: null });
      } else {
        const match = TOOLS.find((entry) => entry.key === event.key.toUpperCase());
        if (match) setTool(match.tool);
        else if (event.key === 'Escape') setTool('select');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.layout, state.selection, tool]);

  const openFile = async (file: File) => {
    const result = parseLayoutJson(await file.text());
    if (result.layout) {
      const errors = result.ok ? 0 : result.errors.length;
      load(
        result.layout,
        errors
          ? `Opened ${file.name}. It has ${errors} ${errors === 1 ? 'problem' : 'problems'} to fix, listed under Checks.`
          : `Opened ${file.name}.`
      );
    } else if (!result.ok) {
      const [first] = result.errors;
      setMessage(
        `Couldn't open ${file.name}: ${first?.path.length ? `${first.path.join('.')}: ` : ''}${first?.message ?? 'not a layout'}`
      );
    }
  };

  const isEmpty = state.layout.rooms.length === 0;
  const confirmReplace = () =>
    isPristine(state) || window.confirm('Replace the current layout? You can still save it first.');

  return (
    <div className="app">
      <header className="topbar">
        <h1>Spatial Home</h1>
        <div className="actions">
          <button type="button" onClick={() => confirmReplace() && load(createEmptyLayout())}>
            New
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>
            Open…
          </button>
          <button type="button" onClick={() => downloadLayout(state.layout)}>
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              const result = validateLayout(sample);
              if (result.layout && confirmReplace()) load(result.layout, 'Loaded the sample flat.');
            }}
          >
            Sample
          </button>
          <span className="divider" />
          <button
            type="button"
            disabled={state.past.length === 0}
            onClick={() => dispatch({ type: 'undo' })}
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>
          <button
            type="button"
            disabled={state.future.length === 0}
            onClick={() => dispatch({ type: 'redo' })}
            title="Redo (Ctrl+Shift+Z)"
          >
            Redo
          </button>
          <button
            type="button"
            onClick={() => setFitRequest((n) => n + 1)}
            title="Fit the plan to the window"
          >
            Fit
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file && confirmReplace()) void openFile(file);
          }}
        />
      </header>

      <nav className="tools" aria-label="Tools">
        {TOOLS.map(({ tool: entry, label, key }) => (
          <button
            key={entry}
            type="button"
            className={tool === entry ? 'active' : ''}
            aria-pressed={tool === entry}
            onClick={() => setTool(entry)}
            title={`${label} (${key})`}
          >
            {label}
            <kbd>{key}</kbd>
          </button>
        ))}
      </nav>

      <main className="canvas">
        <PlanView
          state={state}
          dispatch={dispatch}
          tool={tool}
          flagged={flagged}
          onMessage={setMessage}
          fitRequest={fitRequest}
        />
        {message && (
          <div className="toast" role="status">
            {message}
          </div>
        )}
        {isEmpty && tool === 'select' && (
          <div className="empty-state">
            <p>
              Draw your first room with the Room tool (R), or open the sample flat to see how a
              layout looks.
            </p>
          </div>
        )}
      </main>

      <aside className="sidebar">
        <Inspector state={state} dispatch={dispatch} />
        <IssuesPanel
          issues={issues}
          layout={state.layout}
          onSelect={(selection) => dispatch({ type: 'select', selection })}
        />
      </aside>
    </div>
  );
}
