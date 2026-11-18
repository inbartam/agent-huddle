/**
 * The M2 meter sections of the agent detail (F4 progress and ETA, F5 usage, F6 context health, F7 handoff), and
 * the bar they share with the widget rows. Sections sit one after another under a hairline (DESIGN.md: no cards).
 * Every number that is an estimate says so; every unknown says so.
 */
import { useId, type ReactNode } from 'react';
import {
  selectAgent,
  selectContextWarning,
  selectProgress,
  selectUsageRollup,
  type AgentNode,
  type Handoff,
  type HuddleState,
  type TokenUsage,
} from '@huddle/shared';
import {
  approxUsd,
  clockTime,
  clockTimeFull,
  count,
  linkQuality,
  percent,
  plural,
  shortCount,
  UNKNOWN,
} from '../view/format.js';
import { contextSource, knownCostUsd, knownUsage, progressWords, totalTokens, workTotal } from '../view/meters.js';
import { statusLook, type StatusTone } from '../view/status.js';
import { TEAMMATE_WORDS, teammateCount, usageRollupHead } from '../view/teammates.js';
import { MessageText } from './MessageText.js';
import { plainLine } from '../view/markdown.js';

/**
 * A thin horizontal bar, `role="progressbar"`. A known fraction fills it and sets `aria-valuenow`; an unknown one
 * (null) draws a hatched, empty track with `aria-valuetext` saying it is unknown, never a 0 bar. `valueText` replaces
 * the spoken value ("2 of 3 subagents done, estimate").
 */
export function Bar({
  fraction,
  label,
  tone = 'working',
  thin = false,
  valueText,
  className,
}: {
  fraction: number | null;
  label: string;
  tone?: StatusTone;
  thin?: boolean;
  valueText?: string;
  className?: string;
}) {
  const extra = `${thin ? ' bar-thin' : ''}${className ? ` ${className}` : ''}`;
  if (fraction === null || !Number.isFinite(fraction)) {
    return (
      <span
        className={`bar bar-unknown tone-${tone}${extra}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={valueText ?? 'unknown'}
      />
    );
  }
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <span
      className={`bar tone-${tone}${extra}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={valueText}
    >
      <span className="bar-fill" style={{ width: `${String(pct)}%` }} />
    </span>
  );
}

export function Section({
  title,
  children,
  note,
  id,
  className,
}: {
  title: string;
  children: ReactNode;
  note?: string;
  /** DOM id of the section element (anchors); the heading gets its own id for the accessible name. */
  id?: string;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section className={`meter-section${className ? ` ${className}` : ''}`} id={id} aria-labelledby={headingId}>
      <h2 className="section-title" id={headingId}>
        {title}
        {note && <span className="section-note">{note}</span>}
      </h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Progress (F4)
// ---------------------------------------------------------------------------

/**
 * `replay` (M5): a past moment. The ETA is left out, because it depends on the clock and on today's scorecards, so it
 * would not be what was shown then; a line says so instead.
 */
export function ProgressSection({
  state,
  agent,
  now,
  replay = false,
}: {
  state: HuddleState;
  agent: AgentNode;
  now: number;
  replay?: boolean;
}) {
  const words = progressWords(selectProgress(state, agent.key, now, { priors: state.priors ?? null }), agent);
  if (words.counted === null) {
    return (
      <Section title="Progress">
        {/* No bar: an empty track next to "—" read as broken (owner, 2026-11-18). One line says why there is none. */}
        <p className="meter-line muted">
          No task list or subagents to measure progress by.
          {agent.currentActivity ? ' Doing now: ' : ''}
          {agent.currentActivity && <span className="meter-activity">{agent.currentActivity}</span>}
        </p>
      </Section>
    );
  }
  return (
    <Section title="Progress" note="estimate">
      {words.fraction !== null ? (
        <div className="meter-row" title={words.source ?? undefined}>
          <Bar fraction={words.fraction} label={`Progress, estimated ${percent(words.fraction * 100)}`} />
          <span className="meter-value">~{percent(words.fraction * 100)} est.</span>
        </div>
      ) : (
        // F27: the agent gave minutes left and no percent: no bar (unknown is not 0), the time left below.
        <p className="meter-line muted">Percent done: {UNKNOWN}</p>
      )}
      <p className="meter-line" title={words.source ?? undefined}>
        {words.counted}
        {words.source !== null && <span className="visually-hidden"> ({words.source})</span>}
      </p>
      {replay && <p className="meter-line muted">Time left isn&apos;t shown in a replay.</p>}
      {!replay && words.eta && (
        <p className="meter-line">
          {words.eta}
          <span className="muted"> · est., {words.confidence}</span>
        </p>
      )}
      {words.scopeGrew && (
        <p className="meter-line scope-grew">
          <span className="scope-mark" aria-hidden="true">
            +
          </span>
          Scope grew: subagents started after others had finished, so the bar moved back.
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Usage (F5)
// ---------------------------------------------------------------------------

const USAGE_ROWS: { label: string; get: (u: TokenUsage) => string }[] = [
  { label: 'Total tokens', get: (u) => count(totalTokens(u)) },
  { label: 'Input tokens', get: (u) => count(u.inputTokens) },
  { label: 'Output tokens', get: (u) => count(u.outputTokens) },
  { label: 'Cache read', get: (u) => count(u.cacheReadTokens) },
  { label: 'Cache written', get: (u) => count(u.cacheCreationTokens) },
  { label: 'Requests', get: (u) => count(u.requests) },
  {
    label: 'Cost',
    get: (u) => {
      const usd = knownCostUsd(u);
      return usd === null ? UNKNOWN : `${approxUsd(usd)} est.`;
    },
  },
];

function cell(usage: TokenUsage | null, get: (u: TokenUsage) => string): string {
  return usage === null ? UNKNOWN : get(usage);
}

export function UsageSection({ state, agent }: { state: HuddleState; agent: AgentNode }) {
  const own = knownUsage(agent.usage);
  const rollup = agent.childKeys.length > 0 || agent.kind === 'main' ? selectUsageRollup(state, agent.key) : null;
  const showRollup = rollup !== null && rollup.agentCount > 1;
  const total = rollup ? knownUsage(rollup.usage) : null;
  const helper = rollup ? knownUsage(rollup.helperUsage) : null;
  const columns: { head: string; usage: TokenUsage | null }[] = [{ head: 'This agent', usage: own }];
  const leadsTeammates =
    teammateCount(
      agent.childKeys.flatMap((k) => {
        const child = selectAgent(state, k);
        return child ? [child] : [];
      }),
    ) > 0;
  if (showRollup) columns.push({ head: usageRollupHead(leadsTeammates, rollup.agentCount), usage: total });
  if (helper !== null) columns.push({ head: 'Helper requests', usage: helper });

  const withoutCost = showRollup ? (total?.requestsWithoutCost ?? 0) : (own?.requestsWithoutCost ?? 0);
  const withoutId = showRollup ? (total?.requestsWithoutId ?? 0) : (own?.requestsWithoutId ?? 0);

  return (
    <Section title="Usage">
      {own === null &&
        (agent.kind === 'teammate' ? (
          // M6 (S20): an in-process teammate's requests carry no agent id, so they land on the lead.
          <p className="meter-line muted">{TEAMMATE_WORDS.tokensOnLead}</p>
        ) : (
          <p className="meter-line muted">No requests recorded for this agent yet: usage unknown.</p>
        ))}
      <table className="usage-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Measure</span>
            </th>
            {columns.map((c) => (
              <th scope="col" key={c.head}>
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {USAGE_ROWS.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              {columns.map((c) => (
                <td key={c.head}>{cell(c.usage, r.get)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="meter-notes">
        <li>Cost is Claude Code&apos;s own estimate at API prices; on a subscription it is not money spent.</li>
        {showRollup && rollup.partial && (
          <li>Partial: some agents in this team have no requests recorded yet, so the total is a lower bound.</li>
        )}
        {helper !== null && (
          <li>Helper requests (titles, summaries, compaction) count in the total and are shown on their own here.</li>
        )}
        {withoutCost > 0 && <li>{plural(withoutCost, 'request')} carried no cost: the cost is a lower bound.</li>}
        {withoutId > 0 && (
          <li>{plural(withoutId, 'request')} had no request id and could not be checked for repeats.</li>
        )}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Context (F6)
// ---------------------------------------------------------------------------

export function ContextSection({ agent }: { agent: AgentNode }) {
  const ctx = agent.context;
  const warning = selectContextWarning(agent);
  const high = warning === 'high';
  return (
    <Section title="Context">
      {ctx.usedPct === null ? (
        <p className="meter-line">
          <span className="meter-value">unknown</span>
          <span className="muted">
            {' '}
            ·{' '}
            {ctx.usedTokens !== null
              ? `${count(ctx.usedTokens)} tokens used, window size unknown`
              : contextSource(ctx.measuredBy)}
          </span>
        </p>
      ) : (
        <>
          <div className={`meter-row${high ? ' is-high' : ''}`}>
            <Bar
              fraction={ctx.usedPct / 100}
              tone={high ? 'needs-you' : 'idle'}
              label={`Context ${percent(ctx.usedPct)} full`}
            />
            <span className={`meter-value${high ? ' tone-needs-you' : ''}`}>{percent(ctx.usedPct)}</span>
          </div>
          <p className="meter-line">
            {count(ctx.usedTokens)} of {count(ctx.windowTokens)} tokens
            <span className="muted"> · {contextSource(ctx.measuredBy)}</span>
          </p>
          {high && (
            <p className="meter-line context-high">
              Nearly full: Claude Code will compact soon and older detail may be summarized away.
            </p>
          )}
        </>
      )}
      <dl className="facts">
        <dt>Compactions</dt>
        <dd>
          {ctx.compactions === 0 ? 'none' : String(ctx.compactions)}
          {ctx.lastCompactedAt !== null && (
            <span className="fact-note" title={clockTimeFull(ctx.lastCompactedAt)}>
              last at {clockTime(ctx.lastCompactedAt)}
            </span>
          )}
        </dd>
        <dt>Instruction files</dt>
        <dd className="instructions">
          {ctx.loadedInstructions.length === 0 ? (
            <span className="muted">none reported</span>
          ) : (
            <ul>
              {ctx.loadedInstructions.map((path) => (
                <li key={path} className="code" title={path}>
                  {path}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Handoff inspector (F7)
// ---------------------------------------------------------------------------

/** The same rail the tree draws for this link: solid when exact, dashed while it is a best guess. */
function LinkMark({ link, tone }: { link: Handoff['link']; tone: StatusTone }) {
  const exact = link === 'exact';
  return (
    <span className="link-mark">
      <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
        <path
          className={`rail tone-${tone} ${exact ? 'rail-solid' : 'rail-dashed'}`}
          data-on="true"
          d="M 2 0 V 1 Q 2 5 6 5 H 20"
        />
      </svg>
      <span>{exact ? 'linked exactly' : linkQuality(link)}</span>
    </span>
  );
}

function HandoffText({ label, text }: { label: string; text: string | null }) {
  if (text === null || text.trim() === '') {
    return (
      <div className="handoff-part">
        <h3 className="handoff-label">{label}</h3>
        <p className="muted">{UNKNOWN}</p>
      </div>
    );
  }
  return (
    <details className="handoff-part">
      <summary>
        <span className="handoff-label">{label}</span>
        <span className="handoff-preview">{plainLine(text)}</span>
      </summary>
      {/* Agent text, drawn from its Markdown as React elements: text children only, never HTML (SECURITY.md). */}
      <div className="handoff-text">
        <MessageText text={text} />
      </div>
    </details>
  );
}

export function HandoffSection({ agent }: { agent: AgentNode }) {
  const handoff = agent.handoff;
  if (agent.kind === 'main' || handoff === null) return null;
  return (
    <Section title="Handoff">
      <p className="meter-line">
        <LinkMark link={handoff.link} tone={statusLook(agent.status).tone} />
      </p>
      <HandoffText label="Brief" text={handoff.brief} />
      <HandoffText label="Result" text={handoff.result} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Simple view (owner's request 2026-11-17): a bar where a share is the point, no token tables
// ---------------------------------------------------------------------------

/**
 * Tokens as a share: this agent's tokens out of its session's (the lead's roll-up). One bar and one line; the exact
 * figures are in the Advanced view. Unknown says so and draws a hatched bar, never 0.
 */
export function TokenShareSection({ state, agent }: { state: HuddleState; agent: AgentNode }) {
  // Work tokens (input + output), as History counts them; cache reads are in the Advanced usage table.
  const own = workTotal(agent.usage);
  const rootKey = agent.parentKey === null ? agent.key : agent.sessionId;
  const rollup = selectUsageRollup(state, rootKey);
  const all = rollup ? workTotal(rollup.usage) : null;
  const usd = knownCostUsd(agent.usage);
  const share = own !== null && all !== null && all > 0 ? Math.min(1, own / all) : null;
  // A share is only news when others share the session: an agent alone (or one that did all the work) is not "100%".
  // A share that rounds to 100% (others used a sliver, e.g. 99.6%) is not news either: no "77k of 77k" (owner, 2026-11-18).
  const shared = share !== null && share < 0.995;
  const words =
    own === null
      ? agent.kind === 'teammate'
        ? TEAMMATE_WORDS.tokensOnLead
        : 'No requests recorded for this agent yet: tokens unknown.'
      : shared && all !== null
        ? `${shortCount(own)} of ${shortCount(all)} tokens in this session`
        : `${shortCount(own)} tokens`;
  return (
    <Section title="Tokens">
      {(shared || own === null) && (
        <div className="meter-row">
          <Bar
            fraction={shared ? share : null}
            tone="idle"
            label="This agent's share of the session's tokens"
            valueText={shared ? `${percent(share * 100)} of the session's tokens` : 'unknown'}
          />
          <span className="meter-value">{shared ? percent(share * 100) : UNKNOWN}</span>
        </div>
      )}
      <p className="meter-line">
        {words}
        {usd !== null && <span className="muted"> · {approxUsd(usd)} est.</span>}
      </p>
    </Section>
  );
}

/** Context in one bar and one line: how full the window is, or unknown. */
export function ContextBarSection({ agent }: { agent: AgentNode }) {
  const ctx = agent.context;
  const high = selectContextWarning(agent) === 'high';
  const pct = ctx.usedPct;
  if (pct === null)
    return (
      <Section title="Context">
        {/* No empty bar and bare "—": say when a reading comes (owner, 2026-11-18). */}
        <p className="meter-line muted">
          {agent.kind === 'main' || agent.parentKey === null
            ? 'Not measured yet: Claude Code reports it with the agent’s next request.'
            : 'Not measured yet: a subagent’s context arrives with its own requests.'}
        </p>
      </Section>
    );
  return (
    <Section title="Context">
      <div className={`meter-row${high ? ' is-high' : ''}`}>
        <Bar
          fraction={pct / 100}
          tone={high ? 'needs-you' : 'idle'}
          label="Context window used"
          valueText={`${percent(pct)} full`}
        />
        <span className={`meter-value${high ? ' tone-needs-you' : ''}`}>{`${percent(pct)} full`}</span>
      </div>
      {high && <p className="meter-line context-high">Nearly full: older detail may be summarized away soon.</p>}
    </Section>
  );
}
