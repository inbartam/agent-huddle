/**
 * Main window (main window redesign, WP2 and WP3): title bar (brand, Search Ctrl+K, live counts), the 56 px icon rail,
 * the sidebar (Needs you, then projects → sessions → agents; 312 px, 280–420, splitter), and the main area showing the
 * current place: Home (the default: counts, Ask, Today), a session (Live · Replay · Report), History, Library
 * (Templates · Rules), Settings, or Launch. The first-run guide is a dialog over it, once and from the rail's Guide.
 *
 * Where each earlier view lives now: Launch… → "+ New run" in the sidebar and "Start a run" on Home; Templates and
 * Rules → Library; History and Scorecards → History (its tabs); Ask → the card on Home (the palette hands questions to
 * it); Settings → the rail; the team tree → the sidebar's projects and each session view; the inbox → Needs you.
 * Budget and worktree actions stay in the agent panel of the session view.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  selectAgent,
  selectHiddenSessionCount,
  selectHomeCounts,
  selectProjects,
  selectSessionIdentity,
  selectTree,
  type AgentKey,
  type HuddleCommand,
  type HuddleState,
  type SkillDraft,
} from '@huddle/shared';
import type { DetailSection } from '../components/AgentDetail.js';
import { ErrorLine } from '../components/Chrome.js';
import { ConnectionBanner, ConsentScreen } from '../components/Connection.js';
import { ControlButton } from '../components/ControlButton.js';
import { Guide } from '../components/Guide.js';
import { Home } from '../components/Home.js';
import { HistoryPanel } from '../components/History.js';
import { LaunchPanel } from '../components/LaunchForm.js';
import { Palette } from '../components/Palette.js';
import { RulesPanel } from '../components/Rules.js';
import { SettingsPanel } from '../components/SettingsPanel.js';
import { SessionView } from '../components/SessionView.js';
import { Library, Rail, Splitter, TitleBar } from '../components/Shell.js';
import { Sidebar } from '../components/Sidebar.js';
import { RolesPanel } from '../components/Roles.js';
import { SkillsPanel } from '../components/Skills.js';
import { TasksPanel } from '../components/Tasks.js';
import { TemplatesPanel } from '../components/Templates.js';
import { useDecisions } from '../useDecisions.js';
import { useSnapshot, type HuddleStore } from '../store.js';
import { useNow } from '../useNow.js';
import { useTimeline } from '../useTimeline.js';
import { useViewMode } from '../viewMode.js';
import { itemFromHash, linkedAgent, linkedItem } from '../view/deep-link.js';
import type { HistoryRequest } from '../view/history.js';
import { skillDraftFromAsk, taskDraftFromAsk, type TaskDraft } from '../view/orch.js';
import { allControl, lastHoldEnding } from '../view/inbox.js';
import type { PaletteAction } from '../view/palette.js';
import { browserStore, markGuideSeen, shouldShowGuide } from '../view/prefs.js';
import type { RuleDraft } from '../view/rules.js';
import { currentSettings } from '../view/settings.js';
import {
  clampSidebarWidth,
  railCurrent,
  shellColumns,
  SIDEBAR_DEFAULT,
  type LibraryTab,
  type Place,
  type RailPlace,
} from '../view/shell.js';
import { treeOptions } from '../view/summary.js';
import type { TimelineFilter } from '../view/timeline.js';
import { revealToggles } from '../view/tree.js';

const WIDTH_KEY = 'huddle.sidebarWidth';

/** The sidebar width is a per-window convenience; storage may be unavailable, so never depend on it. */
function loadWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    return raw ? clampSidebarWidth(Number(raw)) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}
function saveWidth(px: number): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(px));
  } catch {
    /* not persisted; the default comes back next time */
  }
}

export function MainView({ store }: { store: HuddleStore }) {
  const { state, error, renames } = useSnapshot(store);
  const [picked, setPicked] = useState<AgentKey | null>(null);
  const [toggled, setToggled] = useState<ReadonlySet<AgentKey>>(new Set());
  const [section, setSection] = useState<DetailSection>('timeline');
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [sidebarWidth, setSidebarWidth] = useState(loadWidth);
  const [showAll, setShowAll] = useState(false);
  // Per project id, what the user chose (open or closed); kept here so it survives a session ending.
  const [projectChoices, setProjectChoices] = useState<ReadonlyMap<string, boolean>>(new Map());
  const consent = useConsent(store);
  const [place, setPlace] = useState<Place>('home');
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('templates');
  const [paletteOpen, setPaletteOpen] = useState(false);
  // What History opens on; `n` remounts it when asked again while it is already showing.
  const [historyReq, setHistoryReq] = useState<HistoryRequest & { n: number }>({ tab: 'runs', run: null, n: 0 });
  const showHistory = useCallback((req: HistoryRequest) => {
    setHistoryReq((prev) => ({ ...req, n: prev.n + 1 }));
    setPlace('history');
  }, []);
  // The palette's Ask hand-off: Home's Ask card gets the question in its box (never sent); `n` marks each hand-off.
  const [askPrefill, setAskPrefill] = useState<{ question: string; n: number } | null>(null);
  const showAsk = useCallback((question: string | null) => {
    if (question !== null) setAskPrefill((prev) => ({ question, n: (prev?.n ?? 0) + 1 }));
    setPlace('home');
  }, []);
  // "Make a rule from this…": Library opens on Rules with the editor filled in; `n` remounts the panel for each one.
  const [rulePrefill, setRulePrefill] = useState<{ draft: RuleDraft; n: number } | null>(null);
  // The first-run guide: once (not over the consent screen), and from the rail's Guide.
  const [guideOpen, setGuideOpen] = useState(() => shouldShowGuide(browserStore(), false));
  const closeGuide = useCallback(() => {
    markGuideSeen(browserStore());
    setGuideOpen(false);
  }, []);
  // Settings opened at a section (Ask's "Turn on in Settings"); `n` remounts it so it scrolls there again.
  const [settingsAt, setSettingsAt] = useState<{ section: 'ask' | null; n: number }>({ section: null, n: 0 });
  const showSettings = useCallback((section: 'ask' | null) => {
    setSettingsAt((prev) => ({ section, n: prev.n + 1 }));
    setPlace('settings');
  }, []);
  // F28/F29: Ask's "Create skill from this" / "Make a task from this" open Library with the form filled in. `n` only
  // grows, so the panel remounts for each hand-off and for each opening of Library (an old draft never comes back).
  const [orch, setOrch] = useState<{
    prefill: { kind: 'skill'; draft: SkillDraft } | { kind: 'task'; draft: TaskDraft } | null;
    n: number;
  }>({ prefill: null, n: 0 });
  // Library from anywhere but "Make a rule from this…" opens without a draft: an old one never comes back.
  const showLibrary = useCallback((tab: LibraryTab, draft: RuleDraft | null = null) => {
    setRulePrefill((prev) => (draft === null ? null : { draft, n: (prev?.n ?? 0) + 1 }));
    setOrch((prev) => ({ prefill: null, n: prev.n + 1 }));
    setLibraryTab(tab);
    setPlace('library');
  }, []);
  const makeFromAsk = useCallback(
    (kind: 'skill' | 'task', question: string, answer: string) => {
      showLibrary(kind === 'skill' ? 'skills' : 'tasks');
      const prefill =
        kind === 'skill'
          ? { kind, draft: skillDraftFromAsk(question, answer) }
          : { kind, draft: taskDraftFromAsk(question, answer) };
      setOrch((prev) => ({ prefill, n: prev.n + 1 }));
    },
    [showLibrary],
  );
  const [linkedItemId, setLinkedItemId] = useState<string | null>(null);
  const viewMode = useViewMode();
  const send = useCallback((cmd: HuddleCommand) => store.command(cmd), [store]);

  // Every session (ended and hidden ones too), so a reveal from a toast, the widget or the palette finds its agent.
  const sessions = useMemo(() => (state ? selectTree(state, treeOptions(state)) : []), [state]);
  const projects = useMemo(
    () => (state ? selectProjects(state, { ...treeOptions(state), showAll }) : []),
    [state, showAll],
  );
  const hidden = useMemo(
    () => (state ? selectHiddenSessionCount(state, { ...treeOptions(state), showAll: false }) : 0),
    [state],
  );
  const homeCounts = useMemo(() => (state ? selectHomeCounts(state, treeOptions(state)) : null), [state]);
  const reveal = useCallback(
    (key: AgentKey) => {
      setPicked(key);
      setPlace('session');
      setToggled((prev) => revealToggles(sessions, key, prev));
    },
    [sessions],
  );
  useLinks(state, reveal, setLinkedItemId);
  const openPalette = useCallback(() => {
    setPaletteOpen(true);
  }, []);
  usePaletteKey(openPalette);
  // A handed-off question is used once: leaving Home drops it, so coming back does not fill the box again.
  useEffect(() => {
    if (place !== 'home') setAskPrefill(null);
  }, [place]);
  // Sidebar session titles (F2, sidebar rule): nickname → session title → first prompt → "Untitled session".
  const now = useNow(60_000);
  const identity = useCallback(
    (key: AgentKey) => (state ? selectSessionIdentity(state, key, now, { renames }) : null),
    [state, now, renames],
  );
  const selected = state && picked ? selectAgent(state, picked) : null;
  const selectedKey = place === 'session' ? (selected?.key ?? null) : null;
  const timeline = useTimeline(store, selectedKey);
  const decisions = useDecisions(store, state, place === 'library' && libraryTab === 'rules');
  const holdEnding = useMemo(
    () => (selectedKey ? lastHoldEnding(timeline.events, selectedKey) : null),
    [timeline.events, selectedKey],
  );

  const goHome = () => {
    setPlace('home');
  };
  const onRail = (p: RailPlace) => {
    if (p === 'history') showHistory({ tab: 'runs', run: null });
    else if (p === 'settings') showSettings(null);
    else if (p === 'guide') setGuideOpen(true);
    else if (p === 'library') showLibrary(libraryTab);
    else setPlace(p);
  };

  const runAction = (a: PaletteAction) => {
    setPaletteOpen(false);
    switch (a.effect.kind) {
      case 'command':
        void send(a.effect.command);
        break;
      case 'select':
        reveal(a.effect.agentKey);
        break;
      case 'settings':
        showSettings(null);
        break;
      case 'team':
        goHome();
        break;
      case 'launch':
        setPlace('launch');
        break;
      case 'templates':
      case 'rules':
      case 'roles':
        showLibrary(a.effect.kind);
        break;
      case 'history':
        showHistory({ tab: a.effect.tab, run: null });
        break;
      case 'ask':
        showAsk(a.effect.question);
        break;
      case 'viewMode':
        viewMode.setMode(a.effect.mode);
        break;
    }
  };

  const toggle = (key: AgentKey) => {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const setWidth = (px: number) => {
    setSidebarWidth(px);
    saveWidth(px);
  };

  const connection = state?.connection;

  // First run (ADR-017): the consent screen takes the window until the user connects or picks "Not now".
  if (connection?.status === 'needs_consent' && connection.preview && !consent.later) {
    return (
      <div className="main-window is-setup">
        <TitleBar counts={homeCounts} state={state} onSearch={openPalette} searchable={false} />
        <ConsentScreen
          preview={connection.preview}
          notice={consent.notice}
          error={consent.error}
          busy={consent.busy}
          onConnect={consent.connect}
          onLater={consent.postpone}
        />
      </div>
    );
  }

  const main = (() => {
    if (place === 'history')
      return (
        <HistoryPanel
          key={historyReq.n}
          query={store.query}
          request={historyReq}
          retentionDays={state?.settings?.history.retentionDays ?? null}

          onShowLive={reveal}
          onCommand={send}
        />
      );
    if (state === null) return null;
    switch (place) {
      case 'settings':
        return (
          <SettingsPanel
            key={settingsAt.n}
            state={state}
            {...(settingsAt.section ? { initialSection: settingsAt.section } : {})}
            onCommand={send}
            query={store.query}
          />
        );
      case 'launch':
        return <LaunchPanel state={state} onCommand={send} query={store.query} onClose={goHome} />;
      case 'library':
        return (
          <Library
            tab={libraryTab}
            onTab={(t) => {
              setRulePrefill(null);
              setOrch((prev) => ({ prefill: null, n: prev.n }));
              setLibraryTab(t);
            }}
          >
            {libraryTab === 'templates' ? (
              <TemplatesPanel state={state} onCommand={send} query={store.query} />
            ) : libraryTab === 'roles' ? (
              <RolesPanel state={state} onCommand={send} />
            ) : libraryTab === 'skills' ? (
              <SkillsPanel
                key={orch.n}
                query={store.query}
                onCommand={send}

                prefill={orch.prefill?.kind === 'skill' ? orch.prefill.draft : null}
              />
            ) : libraryTab === 'tasks' ? (
              <TasksPanel
                key={orch.n}
                state={state}
                onCommand={send}

                onOpenRun={reveal}
                prefill={orch.prefill?.kind === 'task' ? orch.prefill.draft : null}
              />
            ) : (
              <RulesPanel
                key={rulePrefill?.n ?? 0}
                state={state}
                renames={renames}
                onCommand={send}
                query={store.query}
                decisions={decisions}

                prefill={rulePrefill?.draft ?? null}
                onPrefillDone={() => {
                  setRulePrefill(null);
                }}
              />
            )}
          </Library>
        );
      case 'session':
        return picked !== null ? (
          <SessionView
            key={selected?.sessionId ?? picked}
            state={state}
            agentKey={picked}
            renames={renames}
            now={now}
            query={store.query}
            onCommand={send}
            onRename={(key, name) => store.rename(key, name)}
            onSelect={reveal}
            onHome={goHome}
            section={section}
            onSection={setSection}
            timeline={timeline}
            filter={filter}
            onFilter={setFilter}
            lastHoldEnding={holdEnding}
            onMakeRule={(draft) => {
              showLibrary('rules', draft);
            }}
          />
        ) : (
          <p className="empty">Pick a session on the left.</p>
        );
      default:
        return (
          <Home
            projects={projects}
            now={now}
            identity={identity}
            onStart={() => {
              setPlace('launch');
            }}
            onHistory={() => {
              showHistory({ tab: 'runs', run: null });
            }}
            onOpenSession={reveal}
            askEnabled={currentSettings(state).ask.enabled}
            askStatus={state.ask ?? null}
            query={store.query}
            onCommand={send}
            onOpenAskSettings={() => {
              showSettings('ask');
            }}
            askPrefill={askPrefill}
            onMakeTask={(q, a) => {
              makeFromAsk('task', q, a);
            }}
            onMakeSkill={(q, a) => {
              makeFromAsk('skill', q, a);
            }}
          />
        );
    }
  })();

  return (
    <div
      className={`main-window has-rail${viewMode.simple ? ' is-simple' : ''}`}
      style={{ gridTemplateColumns: shellColumns(sidebarWidth) }}
    >
      <TitleBar counts={homeCounts} state={state} onSearch={openPalette} />
      {connection && connection.status !== 'attached' && (
        <div className="banner-slot">
          <ConnectionBanner connection={connection} onReview={consent.review} />
        </div>
      )}

      <Rail current={railCurrent(place)} onPlace={onRail} />

      <div className="side-pane">
        {error && <ErrorLine message={error} />}
        {state === null && !error && <p className="empty">Connecting to the core…</p>}
        {state && (
          <Sidebar
            store={store}
            state={state}
            renames={renames}
            selectedKey={selectedKey}
            toggled={toggled}
            onToggle={toggle}
            projectChoices={projectChoices}
            onProjectOpen={(id, open) => {
              setProjectChoices((prev) => new Map(prev).set(id, open));
            }}
            onPick={(key) => {
              setPicked(key);
              setPlace('session');
              setLinkedItemId(null);
            }}
            onAgent={reveal}
            linkedItemId={linkedItemId}
            identity={identity}
            projects={projects}
            hidden={hidden}
            showAll={showAll}
            onShowAll={setShowAll}
            onNewRun={() => {
              setPlace('launch');
            }}
            onEarlier={() => {
              showHistory({ tab: 'runs', run: null });
            }}
          />
        )}
        {state && <AllActions state={state} send={send} />}
      </div>

      <Splitter width={sidebarWidth} onWidth={setWidth} />

      <main className="detail-pane">{main}</main>
      {guideOpen && <Guide onClose={closeGuide} />}
      {state && paletteOpen && (
        <Palette
          state={state}
          renames={renames}
          viewMode={viewMode.mode}
          onRun={runAction}
          onClose={() => {
            setPaletteOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Pause all and Resume all, one compact row at the foot of the sidebar (owner review 2026-11-17: they sat above
 * everything). When both are off, one line says why instead of two dead buttons' tooltips.
 */
function AllActions({ state, send }: { state: HuddleState; send: (cmd: HuddleCommand) => Promise<unknown> }) {
  const pause = allControl(state, 'pause');
  const resume = allControl(state, 'resume');
  return (
    <div className="side-actions" role="group" aria-label="Every agent">
      <ControlButton
        control={pause}
        onPress={() => {
          void send({ type: 'all.pause' });
        }}
        variant="quiet"
        hint="Every running agent stops at its next tool call"
      >
        Pause all
      </ControlButton>
      <ControlButton
        control={resume}
        onPress={() => {
          void send({ type: 'all.resume' });
        }}
        variant="quiet"
        hint="Every paused agent carries on"
      >
        Resume all
      </ControlButton>
      {!pause.enabled && !resume.enabled ? (
        <span className="side-actions-reason">Nothing is running or paused.</span>
      ) : !pause.enabled ? (
        <span className="side-actions-reason">{pause.reason}</span>
      ) : !resume.enabled ? (
        <span className="side-actions-reason">{resume.reason}</span>
      ) : null}
    </div>
  );
}

/** Ctrl+K anywhere in the main window opens the palette. */
function usePaletteKey(open: () => void): void {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
}

/** The URL fragment now (the first load can already carry `#agent=<key>`). */
function readLink(): string {
  return window.location.hash;
}

/** Drop the fragment without navigating, so asking for the same agent again changes the URL again. */
function clearLink(): void {
  if (window.location.hash === '') return;
  try {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  } catch {
    /* the next request still selects; only a repeat of the same agent would be missed */
  }
}

/**
 * Selection asked for from outside the window (see view/deep-link.ts):
 *  -  (M3, a toast click): the inbox item is highlighted and scrolled to, and its agent selected. Checked
 *    first, so the agent check below never drops an item fragment.
 *  -  (a widget row): the agent is selected.
 * An id or key is used only if it names something in state; then the fragment is cleared. One the state does not know
 * (yet) waits for the first state, then is dropped.
 */
function useLinks(
  state: HuddleState | null,
  selectAgentKey: (key: AgentKey) => void,
  selectItem: (id: string) => void,
): void {
  const [link, setLink] = useState<string>(readLink);
  useEffect(() => {
    const onHash = () => {
      setLink(readLink());
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  useEffect(() => {
    if (link === '' || state === null) return;
    if (itemFromHash(link) !== null) {
      const id = linkedItem(link, state);
      const item = id === null ? undefined : state.inbox.find((i) => i.id === id);
      if (id !== null && item !== undefined) {
        if (Object.hasOwn(state.agents, item.agentKey)) selectAgentKey(item.agentKey);
        selectItem(id);
      }
    } else {
      const key = linkedAgent(link, state);
      if (key !== null) selectAgentKey(key);
    }
    setLink('');
    clearLink();
  }, [link, state, selectAgentKey, selectItem]);
}

interface ConsentFlow {
  /** The user chose "Not now": show the normal view with a banner until they ask to review again. */
  later: boolean;
  notice: string | null;
  error: string | null;
  busy: boolean;
  connect: () => void;
  postpone: () => void;
  review: () => void;
}

/** Local UI state for the first-run screen. What the change is, and whether it applied, lives in core state. */
function useConsent(store: HuddleStore): ConsentFlow {
  const [later, setLater] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connect = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void store.attach().then((result) => {
      setBusy(false);
      if (result.ok) {
        setNotice(null);
        return;
      }
      // expired: state already carries the refreshed change; say why it is shown again.
      if (result.code === 'expired') setNotice(result.message);
      else setError(result.message);
    });
  };
  return {
    later,
    notice,
    error,
    busy,
    connect,
    postpone: () => {
      setLater(true);
    },
    review: () => {
      setLater(false);
    },
  };
}
