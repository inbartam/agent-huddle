/**
 * The phone view, masked once more on its way out (M6, F26). `selectPhoneView` (shared) already picks only what a
 * phone may see, from state whose text was masked when it was stored; this pass masks every free-text field again
 * (and the caller scrubs the ingest token), so a secret in a shape added to `maskSecrets` later, or text that reached
 * the state some other way, does not leave the computer. Identifiers (keys, request ids) are left as they are: the
 * phone sends them back. The control reasons and "where a message lands" are the Huddle's own fixed words.
 *
 * Question options (ADR-030) are masked like everything else: the phone answers by option index, never by label, so a
 * label changed by this pass cannot make an answer reach the wrong option.
 */
import type { PhoneAgentControls, PhoneControl, PhoneInboxItem, PhoneView } from '@huddle/shared';

function copyControl(c: PhoneControl): PhoneControl {
  return { enabled: c.enabled, reason: c.reason };
}

function copyControls(c: PhoneAgentControls): PhoneAgentControls {
  return {
    message: copyControl(c.message),
    pause: copyControl(c.pause),
    resume: copyControl(c.resume),
    stop: copyControl(c.stop),
  };
}

export function maskPhoneView(view: PhoneView, mask: (text: string) => string): PhoneView {
  return {
    generatedAt: view.generatedAt,
    sessions: view.sessions.map((s) => ({
      rootKey: s.rootKey,
      title: mask(s.title),
      project: s.project === null ? null : mask(s.project),
      agents: s.agents.map((a) => ({
        key: a.key,
        parentKey: a.parentKey,
        depth: a.depth,
        name: mask(a.name),
        role: mask(a.role),
        status: a.status,
        progress: { fraction: a.progress.fraction, label: a.progress.label },
        activity: a.activity === null ? null : mask(a.activity),
        controls: copyControls(a.controls),
        messageLands: a.messageLands,
      })),
    })),
    inbox: view.inbox.map((i): PhoneInboxItem => {
      switch (i.kind) {
        case 'approval': {
          const summary = mask(i.summary);
          return {
            kind: 'approval',
            id: i.id,
            requestId: i.requestId,
            agentKey: i.agentKey,
            agentName: mask(i.agentName),
            toolName: mask(i.toolName),
            summary,
            // A second mask that changed the summary hides part of it too (AX-01).
            hidden: i.hidden || summary !== i.summary,
            createdAt: i.createdAt,
            expiresAt: i.expiresAt,
          };
        }
        case 'question':
          return {
            kind: 'question',
            id: i.id,
            requestId: i.requestId,
            agentKey: i.agentKey,
            agentName: mask(i.agentName),
            title: mask(i.title),
            questions: i.questions.map((q) => ({
              question: mask(q.question),
              header: q.header === null ? null : mask(q.header),
              multiSelect: q.multiSelect,
              options: q.options.map((o) => ({
                label: mask(o.label),
                description: o.description === null ? null : mask(o.description),
              })),
            })),
            answer: copyControl(i.answer),
            createdAt: i.createdAt,
            expiresAt: i.expiresAt,
          };
        default:
          return {
            kind: i.kind,
            id: i.id,
            agentKey: i.agentKey,
            agentName: mask(i.agentName),
            title: mask(i.title),
            createdAt: i.createdAt,
          };
      }
    }),
  };
}
