import type { CleanupOptions, CleanupReport } from '@wells/core';

interface Row { key: keyof CleanupOptions; label: string; count?: number }

export function CleanupPanel({ report, options, onChange }: { report: CleanupReport; options: CleanupOptions; onChange: (o: CleanupOptions) => void }) {
  const rows: Row[] = [
    { key: 'pageNumbers', label: 'Remove page numbers', count: report.pageNumbers },
    { key: 'repeatedHeaders', label: 'Remove repeated headers and footers', count: report.repeatedHeaders },
    { key: 'footnotes', label: 'Remove footnotes', count: report.footnotes },
    { key: 'references', label: 'Remove the reference list', count: report.references },
    { key: 'citations', label: 'Remove citations like [3] or (Smith, 2020)', count: report.citations },
    { key: 'hyphenation', label: 'Rejoin words split across lines', count: report.hyphenatedWords },
    { key: 'lineWraps', label: 'Join broken lines into paragraphs' },
  ];
  return (
    <fieldset className="cleanup">
      <legend>We found</legend>
      <ul className="cleanup-list">
        {rows.map((r) => {
          const none = r.count === 0;
          return (
            <li key={r.key}>
              <label className={none ? 'muted' : ''}>
                <input type="checkbox" checked={options[r.key] && !none} disabled={none}
                  onChange={(e) => onChange({ ...options, [r.key]: e.target.checked })} />
                <span>{r.label}</span>
                {r.count !== undefined && <span className="count">{r.count}</span>}
              </label>
            </li>
          );
        })}
      </ul>
      <p className="hint">
        {report.tables} {report.tables === 1 ? 'table' : 'tables'} and {report.figures} {report.figures === 1 ? 'figure' : 'figures'} found.
        Whether they are read aloud depends on the reading mode.
      </p>
    </fieldset>
  );
}
