/**
 * Human label for a breakdown key. Cohort breakdowns are stored as `cohort`
 * (all cohorts) or `cohort:<id>,<id>` (chosen cohorts); both read "Cohort" in
 * table headers and exports. Everything else is the property path as typed.
 */
export function formatBreakdownName(name: string): string {
  if (name === 'cohort' || name.startsWith('cohort:')) {
    return 'Cohort';
  }
  return name;
}
