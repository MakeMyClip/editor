import { type ReactNode, useId } from 'react';

/**
 * Form field wrapper. Generates a stable id and exposes it via context-like
 * `htmlFor` so screen readers associate the label with the input.
 *
 * The pattern below uses `useId` for the id and a separate <label> + input.
 * The input lives in the `children` prop and is rendered after the label;
 * we attach the id by passing it down via a render prop signature
 * (`children: (id) => ReactNode`) where the caller plugs it into the input.
 *
 * v0.2 keeps this simple: the label uses an aria-label on the wrapper div,
 * inputs are still visually grouped, and the visible <span> serves as the
 * label text. A proper htmlFor/id pairing comes when forms grow.
 */
export function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset className="form-field" aria-labelledby={id}>
      <span id={id} className="form-field-label">
        {label}
      </span>
      {children}
      {hint ? <span className="form-field-hint">{hint}</span> : null}
    </fieldset>
  );
}
