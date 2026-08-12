/**
 * Reconciles a saved records-grid layout with columns added since it was saved.
 *
 * `user_record_layouts.ordered_columns` is a whitelist of VISIBLE columns: a
 * column not in the list is hidden. That makes shipping a new report column
 * invisible to everyone who has ever customised their grid — they do not see a
 * new column, they see nothing, and conclude the feature does not work.
 *
 * Blindly appending every missing column is not the fix either: it would un-hide
 * columns people deliberately removed, which is the same bug pointed the other
 * way.
 *
 * `knownColumns` — the catalog at save time — is what separates the two cases.
 */

export interface LayoutMergeInput {
  orderedColumns: readonly string[];
  /** Catalog at save time; null for layouts saved before it was recorded. */
  knownColumns: readonly string[] | null;
  /** The current standard report columns, in their canonical order. */
  standardColumns: readonly string[];
}

/**
 * Returns the visible column list with genuinely-new standard columns appended.
 *
 * - present in `orderedColumns`          -> kept, in the user's order
 * - in `knownColumns`, not in ordered    -> deliberately hidden, stays hidden
 * - in neither                           -> new since the layout was saved, appended
 *
 * When `knownColumns` is null the layout predates this tracking, so nothing can
 * be proven about intent. Those layouts get every missing standard column
 * appended once — visibly wrong is recoverable in seconds, invisibly missing is
 * not — and they self-heal on the user's next save, which records a catalog.
 */
export function mergeNewStandardColumns(input: LayoutMergeInput): string[] {
  const visible = new Set(input.orderedColumns);
  const known = input.knownColumns === null ? null : new Set(input.knownColumns);

  const appended = input.standardColumns.filter(
    (column) => !visible.has(column) && (known === null || !known.has(column)),
  );

  return [...input.orderedColumns, ...appended];
}
