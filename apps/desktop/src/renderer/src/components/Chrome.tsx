/** Small pieces both windows use: the empty state and the error line. */
export const NO_AGENTS = 'No agents running. Start Claude Code in any terminal and it shows up here.';

export function EmptyState() {
  return <p className="empty">{NO_AGENTS}</p>;
}

export function ErrorLine({ message }: { message: string }) {
  return (
    <p className="error-line" role="alert">
      {message}
    </p>
  );
}
