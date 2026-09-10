function escapeCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCSV(rows: (string | number | null | undefined)[][]): string {
  return rows.map((row) => row.map(escapeCsvValue).join(',')).join('\n');
}

export function downloadCSV(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function cohortMembersToCSV(profileIds: string[]): string {
  if (!profileIds.length) return '';
  return buildCSV([['profile_id'], ...profileIds.map((id) => [id])]);
}

type CsvProfile = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  avatar?: string | null;
  isExternal?: boolean;
  createdAt?: Date | string | null;
  lastSeen?: Date | string | null;
  properties?: Record<string, unknown>;
};

// Geo/device properties every profile can carry; emitted right after the
// Mixpanel-shaped columns so the common columns sit in a fixed order.
const PROFILE_PROPERTY_COLUMNS = [
  'city',
  'region',
  'country',
  'os',
  'os_version',
  'browser',
  'browser_version',
  'device',
  'referrer_name',
] as const;

function toIsoSeconds(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 19);
}

function cellValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * One row per profile, as shown in the "View Users" modal.
 *
 * Column order mirrors Mixpanel's user export
 * ($distinct_id, $name, $email, $last_seen, $avatar, $city) so the file drops
 * into the same spreadsheets, then our fixed geo/device columns, then every
 * other profile property present on at least one exported user as its own
 * column (most-populated first). Nothing is folded into a JSON blob.
 */
export function profilesToCSV(profiles: CsvProfile[]): string {
  const fixedPropertyKeys = new Set<string>(PROFILE_PROPERTY_COLUMNS);
  const customCounts = new Map<string, number>();
  for (const p of profiles) {
    for (const [key, value] of Object.entries(p.properties ?? {})) {
      if (fixedPropertyKeys.has(key) || value === undefined || value === null || value === '') {
        continue;
      }
      customCounts.set(key, (customCounts.get(key) ?? 0) + 1);
    }
  }
  const customKeys = [...customCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);

  const header = [
    'distinct_id',
    'name',
    'email',
    'last_seen',
    'avatar',
    ...PROFILE_PROPERTY_COLUMNS,
    'first_name',
    'last_name',
    'identified',
    'profile_created_at',
    ...customKeys,
  ];
  const rows = profiles.map((p) => {
    const props = p.properties ?? {};
    const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
    return [
      p.id,
      name,
      p.email ?? '',
      toIsoSeconds(p.lastSeen),
      p.avatar ?? '',
      ...PROFILE_PROPERTY_COLUMNS.map((key) => cellValue(props[key])),
      p.firstName ?? '',
      p.lastName ?? '',
      p.isExternal ? 'true' : 'false',
      toIsoSeconds(p.createdAt),
      ...customKeys.map((key) => cellValue(props[key])),
    ];
  });
  return buildCSV([header, ...rows]);
}

/** Safe, short filename fragment. */
export function fileSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  );
}

type ChartCsvSerie = {
  names: string[];
  data: { date: string; count: number }[];
};

/**
 * Chart data as Mixpanel's Insights export lays it out: one row per plotted
 * series (event x breakdown values), one column per x-axis bucket, cells are
 * the plotted values. `names[0]` is the series label, the rest are the
 * breakdown values in the report's breakdown order.
 */
export function chartToCSV(
  series: ChartCsvSerie[],
  breakdownNames: string[],
  dateFormat: 'date' | 'datetime' = 'datetime',
): string {
  const formatBucket = (date: string) =>
    dateFormat === 'date' ? date.slice(0, 10) : date;
  const dates: string[] = [];
  const seen = new Set<string>();
  for (const serie of series) {
    for (const point of serie.data) {
      if (!seen.has(point.date)) {
        seen.add(point.date);
        dates.push(point.date);
      }
    }
  }
  dates.sort();
  const header = ['Serie', ...breakdownNames, ...dates.map(formatBucket)];
  const rows = series.map((serie) => {
    const byDate = new Map(serie.data.map((d) => [d.date, d.count]));
    const [label = '', ...breakdownValues] = serie.names;
    const cells: (string | number)[] = [label];
    for (let i = 0; i < breakdownNames.length; i += 1) {
      cells.push(breakdownValues[i] ?? '');
    }
    for (const date of dates) {
      cells.push(byDate.get(date) ?? 0);
    }
    return cells;
  });
  return buildCSV([header, ...rows]);
}

type FunnelCsvSerie = {
  breakdowns: string[];
  steps: { event: { displayName?: string; name: string }; count: number }[];
};

/**
 * Funnel data as Mixpanel's Funnels export lays it out: one row per
 * breakdown value ("Overall" when there is none), one column per step named
 * "(n) step", cells are the users who reached that step.
 */
export function funnelToCSV(
  series: FunnelCsvSerie[],
  breakdownNames: string[],
): string {
  const first = series[0];
  if (!first) return '';
  const stepHeaders = first.steps.map(
    (step, index) => `(${index + 1}) ${step.event.displayName || step.event.name}`,
  );
  const header = [...(breakdownNames.length ? breakdownNames : ['Breakdown']), ...stepHeaders];
  const rows = series.map((serie) => {
    const labels = breakdownNames.length
      ? breakdownNames.map((_, i) => serie.breakdowns[i] ?? '')
      : ['Overall'];
    return [...labels, ...serie.steps.map((step) => step.count)];
  });
  return buildCSV([header, ...rows]);
}
