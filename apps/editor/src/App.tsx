import {
  createEmptyLayout,
  parseLayoutJson,
  validateLayout,
  type HomeLayout,
} from '@spatial-home/home-model';
import sample from '@spatial-home/home-model/examples/sample-flat.json';
import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { Inspector } from './components/Inspector.tsx';
import { IssuesPanel, selectionForIssue } from './components/IssuesPanel.tsx';
import { PlanView, type Tool } from './components/PlanView.tsx';
import { deleteItem, uniqueIds } from './editor/plan.ts';
import { editorReducer, initialState, isPristine } from './editor/state.ts';
import {
  createDraftSaver,
  download,
  downloadLayout,
  loadDraft,
  unreadableDraft,
} from './editor/storage.ts';

// three.js is large, so the 3D view loads the first time it's opened.
const ModelView = lazy(() =>
  import('./components/ModelView.tsx').then((module) => ({ default: module.ModelView }))
);

type ViewKind = 'plan' | '3d';

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'select', label: 'Select', key: 'V' },
  { tool: 'room', label: 'Room', key: 'R' },
  { tool: 'door', label: 'Door', key: 'D' },
  { tool: 'window', label: 'Window', key: 'W' },
  { tool: 'passage', label: 'Passage', key: 'P' },
];

export function App() {
  const [restored] = useState(loadDraft);
  const [state, dispatch] = useReducer(editorReducer, undefined, () =>
    initialState(restored.layout ?? createEmptyLayout())
  );
  // Why the draft kept in this browser couldn't be opened, until the notice is dismissed.
  const [unreadable, setUnreadable] = useState(restored.problem ?? '');
  const [tool, setTool] = useState<Tool>('select');
  const [view, setView] = useState<ViewKind>('plan');
  const [message, setMessage] = useState('');
  const [fitRequest, setFitRequest] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [draftSaver] = useState(() => createDraftSaver());

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

  // Save the draft shortly after each change rather than on every drag step, and at once when the
  // page is closed or hidden, as it may not get another chance. A layout effect, so that a change
  // rendered with flushSync reaches the saver before flushSync returns.
  useLayoutEffect(() => draftSaver.save(state.layout), [draftSaver, state.layout]);
  useEffect(() => {
    const onExit = () => {
      commitFocusedField();
      draftSaver.flush();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') onExit();
    };
    window.addEventListener('pagehide', onExit);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onExit);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      draftSaver.flush();
    };
  }, [draftSaver]);

  // The corners of a room being drawn aren't saved with the draft, so ask before the page goes.
  useEffect(() => {
    if (!drawing) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [drawing]);

  // Commit a field being typed in before any pointer press is handled. The browser would blur it
  // only after the press had changed the selection, and with it what the field edits.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const active = document.activeElement;
      if (!(event.target instanceof Node && active?.contains(event.target))) commitFocusedField();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

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
      } else if (event.key === '3') {
        setView((current) => (current === 'plan' ? '3d' : 'plan'));
      } else if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        tool === 'select' &&
        state.selection
      ) {
        event.preventDefault();
        dispatch({ type: 'edit', layout: deleteItem(state.layout, state.selection), select: null });
      } else if (event.key === 'Escape' && tool === 'select') {
        dispatch({ type: 'select', selection: null });
      } else if (view === 'plan') {
        const match = TOOLS.find((entry) => entry.key === event.key.toUpperCase());
        if (match) setTool(match.tool);
        else if (event.key === 'Escape') setTool('select');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.layout, state.selection, tool, view]);

  // Reading a file takes a moment, so ask about replacing the layout once it has been read, as it
  // is then, and only for the file chosen last.
  const openRequest = useRef(0);
  const openFile = async (file: File) => {
    const request = ++openRequest.current;
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      if (request !== openRequest.current) return;
      setMessage(`Couldn't read ${file.name}: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (request !== openRequest.current) return;
    const result = parseLayoutJson(text);
    if (result.layout) {
      if (!confirmReplace()) return;
      const { layout, renamed } = uniqueIds(result.layout);
      const checked = validateLayout(layout);
      const errors = checked.ok ? 0 : checked.errors.length;
      load(
        layout,
        [
          `Opened ${file.name}.`,
          renamed &&
            (renamed === 1
              ? 'One item had an id already in use, so it was given a new one.'
              : `${renamed} items had ids already in use, so they were given new ones.`),
          errors &&
            `It has ${errors} ${errors === 1 ? 'problem' : 'problems'} to fix, listed under Checks.`,
        ]
          .filter(Boolean)
          .join(' ')
      );
    } else if (!result.ok) {
      const [first] = result.errors;
      setMessage(
        `Couldn't open ${file.name}: ${first?.path.length ? `${first.path.join('.')}: ` : ''}${first?.message ?? 'not a layout'}`
      );
    }
  };

  const isEmpty = state.layout.rooms.length === 0;
  // A room being drawn is work too, and replacing the layout would throw its corners away. Kept in
  // a ref so a file that finishes reading later sees the editor as it is then.
  const pristine = useRef(true);
  pristine.current = isPristine(state) && !drawing;
  const confirmReplace = () =>
    pristine.current || window.confirm('Replace the current layout? You can still save it first.');

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
            title="Fit the home to the window"
          >
            Fit
          </button>
          <span className="divider" />
          <div className="view-switch" role="group" aria-label="View">
            {(
              [
                ['plan', 'Plan'],
                ['3d', '3D'],
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                className={view === kind ? 'active' : ''}
                aria-pressed={view === kind}
                onClick={() => setView(kind)}
                title={`${label} view (3)`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void openFile(file);
          }}
        />
      </header>

      <nav className="tools" aria-label="Tools">
        {TOOLS.map(({ tool: entry, label, key }) => (
          <button
            key={entry}
            type="button"
            className={tool === entry && view === 'plan' ? 'active' : ''}
            aria-pressed={tool === entry && view === 'plan'}
            disabled={view !== 'plan'}
            onClick={() => setTool(entry)}
            title={view === 'plan' ? `${label} (${key})` : 'Switch to the plan to draw'}
          >
            {label}
            <kbd>{key}</kbd>
          </button>
        ))}
      </nav>

      <main className="canvas">
        {view === 'plan' ? (
          <PlanView
            state={state}
            dispatch={dispatch}
            tool={tool}
            flagged={flagged}
            onMessage={setMessage}
            fitRequest={fitRequest}
            onDrawing={setDrawing}
          />
        ) : (
          <Suspense fallback={<div className="empty-state">Loading the 3D view…</div>}>
            <ModelView state={state} dispatch={dispatch} fitRequest={fitRequest} />
          </Suspense>
        )}
        {message && (
          <div className="toast" role="status">
            {message}
          </div>
        )}
        {unreadable && (
          <div className="notice" role="alert">
            <p>
              The layout kept in this browser couldn't be opened ({unreadable}), so this is a new
              one. The old one is kept aside: download it to fix it, then open it.
            </p>
            <button
              type="button"
              onClick={() => {
                const text = unreadableDraft();
                if (text) download(text, 'unopened-layout.json');
              }}
            >
              Download it
            </button>
            <button type="button" onClick={() => setUnreadable('')}>
              Dismiss
            </button>
          </div>
        )}
        {isEmpty && view === 'plan' && tool === 'select' && (
          <div className="empty-state">
            <p>
              Draw your first room with the Room tool (R), or open the sample flat to see how a
              layout looks.
            </p>
          </div>
        )}
        {isEmpty && view === '3d' && (
          <div className="empty-state">
            <p>
              There's nothing to see in 3D yet. Draw a room on the plan, or open the sample flat.
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

/**
 * Inspector fields change the layout when they lose focus, so this blurs the focused one. It renders
 * the change before returning, so whatever runs next sees the new layout.
 */
function commitFocusedField(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) flushSync(() => active.blur());
}
