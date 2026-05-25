DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'activity_event_type') THEN
    CREATE TYPE activity_event_type AS ENUM (
      'LOGIN_SUCCESS',
      'LOGIN_FAILED',
      'LOGOUT',
      'PASSWORD_CHANGED',
      'PASSWORD_RESET',
      'USER_CREATED',
      'USER_PROFILE_UPDATED',
      'USER_ROLE_CHANGED',
      'USER_REGION_REASSIGNED',
      'USER_DEACTIVATED',
      'USER_REACTIVATED',
      'UPLOAD_CREATED',
      'REPORT_GENERATED',
      'REPORT_ROW_EDITED'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS user_activity_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email   TEXT,
  actor_role    user_role,
  region_id     UUID REFERENCES regions(id) ON DELETE SET NULL,
  event_type    activity_event_type NOT NULL,
  target_type   TEXT,
  target_id     UUID,
  ip_address    INET,
  user_agent    TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'SUCCESS'
);

CREATE INDEX IF NOT EXISTS user_activity_log_occurred_at_idx
  ON user_activity_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS user_activity_log_actor_idx
  ON user_activity_log (actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS user_activity_log_region_idx
  ON user_activity_log (region_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS user_activity_log_event_type_idx
  ON user_activity_log (event_type, occurred_at DESC);
