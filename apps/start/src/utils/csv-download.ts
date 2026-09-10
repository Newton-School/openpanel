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
  isExternal?: boolean;
  createdAt?: Date | string | null;
  properties?: Record<string, unknown>;
};

const PROFILE_PROPERTY_COLUMNS = [
  'country',
  'region',
  'city',
  'os',
  'os_version',
  'browser',
  'browser_version',
  'device',
  'referrer_name',
] as const;

/**
 * One row per profile, as shown in the "View Users" modal. Fixed columns
 * first, then the device/geo properties the profile carries; any other
 * custom profile properties are serialised into a single JSON column so
 * nothing is silently dropped.
 */
export function profilesToCSV(profiles: CsvProfile[]): string {
  const header = [
    'profile_id',
    'first_name',
    'last_name',
    'email',
    'identified',
    'profile_created_at',
    ...PROFILE_PROPERTY_COLUMNS,
    'other_properties',
  ];
  const rows = profiles.map((p) => {
    const props = p.properties ?? {};
    const known = new Set<string>(PROFILE_PROPERTY_COLUMNS);
    const other = Object.fromEntries(
      Object.entries(props).filter(([key]) => !known.has(key)),
    );
    return [
      p.id,
      p.firstName ?? '',
      p.lastName ?? '',
      p.email ?? '',
      p.isExternal ? 'true' : 'false',
      p.createdAt ? new Date(p.createdAt).toISOString() : '',
      ...PROFILE_PROPERTY_COLUMNS.map((key) => {
        const value = props[key];
        return value === undefined || value === null ? '' : String(value);
      }),
      Object.keys(other).length ? JSON.stringify(other) : '',
    ];
  });
  return buildCSV([header, ...rows]);
}
