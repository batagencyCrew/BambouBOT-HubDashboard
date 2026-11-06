import { PERIODS, type Period } from "../lib/format";

export function PeriodSelect({ value, onChange, options = PERIODS }: { value: Period; onChange: (p: Period) => void; options?: readonly Period[] }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Time period">
      {options.map((p) => (
        <button
          key={p}
          role="radio"
          aria-checked={p === value}
          className={`segment${p === value ? " segment-active" : ""}`}
          onClick={() => onChange(p)}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
