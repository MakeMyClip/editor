/** A labeled row of toggle buttons for picking one option (the popovers' and
 *  inspector's segmented control). */
export function Choice<L extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { label: L }[];
  value: L;
  onChange: (value: L) => void;
}) {
  return (
    <fieldset className="cap-row" aria-label={label}>
      <span className="cap-row-label">{label}</span>
      {options.map((o) => (
        <button
          type="button"
          key={o.label}
          className={`cap-seg${o.label === value ? ' is-on' : ''}`}
          aria-pressed={o.label === value}
          onClick={() => onChange(o.label)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}
