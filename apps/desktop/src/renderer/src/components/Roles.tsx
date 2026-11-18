/**
 * Library › Roles (2026-11-18, agent types by role): every role the Huddle has seen, the type it was given and why
 * (a guess from its name and description, or set by you), and a menu to change it. A change is one `settings.update`
 * patch; main validates it. The type decides the word on the agent's row, the prop on its face, how long it may be
 * quiet before it looks stuck, whether a file edit is a warning, and its finish line. Role descriptions are agent
 * definition text: rendered as text.
 */
import { useId, useState } from 'react';
import { ROLE_PROFILES, type CommandResult, type HuddleCommand, type HuddleState, type RoleKind } from '@huddle/shared';
import { plainLine } from '../view/markdown.js';
import { roleKindCommand, roleRows, TYPE_OPTIONS, type RoleRow } from '../view/roles.js';
import { useViewMode } from '../viewMode.js';

type Send = (cmd: HuddleCommand) => Promise<CommandResult>;

export const ROLES_WORDS = {
  title: 'Roles',
  intro:
    'Each role gets a type from its name and description. The type sets what Huddle expects: reviewers and researchers read rather than edit, so an edit by one shows in Needs you, and they may stay quiet longer before they look stuck.',
  empty: 'No subagents yet. Roles appear here once an agent starts one.',
  guessed: (label: string) => `Guess: ${label}`,
  setByYou: 'set by you',
  agents: (n: number) => (n === 1 ? '1 agent' : `${String(n)} agents`),
  notNow: 'not running now',
} as const;

function RoleItem({ row, onCommand }: { row: RoleRow; onCommand: Send }) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const profile = ROLE_PROFILES[row.kind];
  return (
    <li className="manage-row role-row">
      <div className="manage-row-main">
        <span className="manage-name code">{row.role}</span>
        <span className="manage-meta">{row.agents > 0 ? ROLES_WORDS.agents(row.agents) : ROLES_WORDS.notNow}</span>
        {row.overridden && <span className="manage-meta role-set">{ROLES_WORDS.setByYou}</span>}
        {row.description !== null && <span className="manage-desc">{plainLine(row.description)}</span>}
        {error !== null && (
          <span className="inline-error" role="alert">
            {error}
          </span>
        )}
      </div>
      <div className="manage-actions">
        <label className="visually-hidden" htmlFor={id}>
          {`Type of ${row.role}`}
        </label>
        <select
          id={id}
          className="text-input select-input role-select"
          value={row.overridden ? row.kind : ''}
          title={profile.about}
          onChange={(e) => {
            setError(null);
            const value = e.target.value;
            const kind = value === '' ? null : (value as RoleKind);
            void onCommand(roleKindCommand(row.role, kind)).then((r) => {
              if (!r.ok) setError(r.message);
            });
          }}
        >
          <option value="">{ROLES_WORDS.guessed(ROLE_PROFILES[row.guess].label)}</option>
          {TYPE_OPTIONS.map((o) => (
            <option key={o.kind} value={o.kind}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </li>
  );
}

export function RolesPanel({ state, onCommand }: { state: HuddleState; onCommand: Send }) {
  const { simple } = useViewMode();
  const rows = roleRows(state.agents, state.settings?.roleKinds);
  return (
    <article className="detail manage roles" aria-label={ROLES_WORDS.title}>
      <header className="detail-head">
        <div className="name-block">
          <h1 className="visually-hidden">{ROLES_WORDS.title}</h1>
        </div>
        {!simple && <p className="muted">{ROLES_WORDS.intro}</p>}
      </header>
      <div className="panel">
        {rows.length === 0 ? (
          <p className="empty-line">{ROLES_WORDS.empty}</p>
        ) : (
          TYPE_OPTIONS.filter((o) => rows.some((r) => r.kind === o.kind)).map((o) => (
            <section key={o.kind} className="role-group" aria-label={o.label}>
              <h2 className="section-title">{o.label}</h2>
              <p className="muted role-about">{ROLE_PROFILES[o.kind].about}</p>
              <ul className="manage-list">
                {rows
                  .filter((r) => r.kind === o.kind)
                  .map((r) => (
                    <RoleItem key={r.role} row={r} onCommand={onCommand} />
                  ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </article>
  );
}
