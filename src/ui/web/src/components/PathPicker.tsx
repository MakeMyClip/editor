import type { Session } from '../types.js';

/**
 * A path input that offers prior op outputs as suggestions while still
 * accepting any typed path. The session-derived options handle the common
 * "use the last output as the next input" flow without making the user
 * paste paths from the terminal.
 */
export function PathPicker({
  value,
  onChange,
  session,
  placeholder,
  listId,
}: {
  value: string;
  onChange: (next: string) => void;
  session: Session;
  placeholder?: string;
  /** Required: each PathPicker on a page needs a unique <datalist> id. */
  listId: string;
}) {
  const prior = priorOutputPaths(session);

  return (
    <>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? '/path/to/video.mp4'}
        list={listId}
        className="form-input"
      />
      <datalist id={listId}>
        {prior.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </>
  );
}

function priorOutputPaths(session: Session): string[] {
  const paths = new Set<string>();
  for (const entry of session.entries) {
    const r = entry.result;
    if (typeof r.path === 'string') paths.add(r.path);
    if (typeof r.before === 'string') paths.add(r.before);
    if (typeof r.after === 'string') paths.add(r.after);
  }
  return Array.from(paths).reverse(); // most-recent first
}
