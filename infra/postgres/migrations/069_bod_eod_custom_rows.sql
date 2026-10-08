-- BOD/EOD rows a Super Admin adds on the RTPL Statuses page, for a status that
-- fits none of the built-in rows (To be Schedule, Customer Pending, ...). A
-- status points at a custom row by row_key, stored in the same
-- rtpl_statuses.bod_eod_bucket column that holds the built-in row names.
-- See shared/src/constants/statusBuckets.ts.
CREATE TABLE IF NOT EXISTS bod_eod_custom_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    row_key VARCHAR(32) NOT NULL UNIQUE,
    label VARCHAR(100) NOT NULL,
    -- How the row's calls count in Engineer Productivity (fixed columns there).
    productivity_bucket VARCHAR(32) NOT NULL,
    -- The built-in row it is shown directly after.
    after_row VARCHAR(32) NOT NULL DEFAULT 'TO_BE_CANCEL',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bod_eod_custom_rows_label
    ON bod_eod_custom_rows (lower(label));
