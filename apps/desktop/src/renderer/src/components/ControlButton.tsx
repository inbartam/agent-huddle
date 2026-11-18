/**
 * A button whose state comes from a `ControlState` (`selectControls`). A disabled one stays focusable and hoverable
 * (`aria-disabled`, not `disabled`, which would hide its tooltip) and its tooltip says why it is off. Every inbox,
 * composer and pause button is one of these, so no component decides on its own whether an action works.
 */
import type { ReactNode } from 'react';
import type { ControlState } from '@huddle/shared';

export interface ControlButtonProps {
  control: ControlState;
  onPress: () => void;
  children: ReactNode;
  /** Tooltip while enabled. */
  hint?: string;
  /** A one-key shortcut inside its card, shown in the tooltip ("A"). */
  shortcut?: string;
  variant?: 'primary' | 'plain' | 'quiet';
  /** A press is in flight: shown as busy, not pressable. */
  busy?: boolean;
  className?: string;
  pressed?: boolean;
}

export function ControlButton({
  control,
  onPress,
  children,
  hint,
  shortcut,
  variant = 'plain',
  busy = false,
  className,
  pressed,
}: ControlButtonProps) {
  const off = !control.enabled;
  const key = shortcut ? ` (${shortcut})` : '';
  const title = off
    ? (control.reason ?? undefined)
    : hint
      ? `${hint}${key}`
      : shortcut
        ? `Shortcut: ${shortcut}`
        : undefined;
  return (
    <button
      type="button"
      className={`control control-${variant}${off ? ' is-off' : ''}${className ? ` ${className}` : ''}`}
      aria-disabled={off || busy ? true : undefined}
      aria-busy={busy ? true : undefined}
      aria-keyshortcuts={shortcut && !off ? shortcut : undefined}
      aria-pressed={pressed}
      title={title}
      data-reason={off ? (control.reason ?? '') : undefined}
      onClick={() => {
        if (!off && !busy) onPress();
      }}
    >
      {children}
    </button>
  );
}
