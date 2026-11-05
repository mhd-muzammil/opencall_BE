-- A remark against a quotation, or against one waiting for approval: a line the office types
-- in the Quotations table's Remark column ("customer will pay on Monday", "called twice, no
-- answer"). Asked for on 5 Nov 2026, for the Visit and the Part tables both.
--
-- The table is the only place it shows. It never goes on the sheet or in the mail, and no box
-- counts it.
--
-- A table of its own rather than a column on quotations and quotation_drafts:
--   * nothing that reads quotations changes — the list, the count boxes, the Sent-folder sweep
--     and the reply watcher select exactly what they selected before, so a deploy whose
--     migration has not run yet loses the Remark column and nothing else;
--   * the boot runner takes no ALTER TABLE lock on quotations, which the API and the
--     mail-worker read all day.
--
-- One row per quotation and one per waiting quotation (the two UNIQUEs), exactly one of the two
-- ids set (the CHECK). A waiting quotation's remark shows on the quotation raised for it — by
-- approving it, or by hand for its WO — until that quotation is given a remark of its own
-- (quotationRemarkRepository), so a remark typed while it waited is not lost.
--
-- updated_by is the actor string quotations.created_by holds, not a users id: a special-access
-- login is not a user.
--
-- Fully ADDITIVE: one new table, so a re-run at boot is a no-op that locks nothing.

CREATE TABLE IF NOT EXISTS quotation_remarks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id  UUID REFERENCES quotations(id) ON DELETE CASCADE,
  draft_id      UUID REFERENCES quotation_drafts(id) ON DELETE CASCADE,
  remark        TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    TEXT NOT NULL DEFAULT '',
  CONSTRAINT quotation_remarks_one_subject CHECK ((quotation_id IS NULL) <> (draft_id IS NULL)),
  CONSTRAINT quotation_remarks_quotation_uniq UNIQUE (quotation_id),
  CONSTRAINT quotation_remarks_draft_uniq UNIQUE (draft_id)
);
