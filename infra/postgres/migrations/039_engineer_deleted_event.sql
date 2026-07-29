-- Add the activity event type used when an engineer record is hard-deleted
-- from the admin console.
--
-- Fully ADDITIVE: one new enum value; nothing else is touched.
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'ENGINEER_DELETED';
