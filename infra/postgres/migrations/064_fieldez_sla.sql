-- What FieldEZ says about each open call's SLA.
--
-- The Open Call Report knows a call exists and how long it has been open; only FieldEZ knows
-- what was promised about it. That promise lives on the ticket's own page — Within SLA,
-- Commercial, ends 2026-08-31 18:00 — and until now the only way to see it was to open the
-- page, one call at a time, nine hundred times.
--
-- This table is where the answer is kept between refreshes, so every screen reads it from
-- here instead of asking FieldEZ again.
--
-- THE DEADLINE, NOT THE COUNTDOWN. FieldEZ's screen says "121h 39m 50s remaining", and
-- storing that would freeze it: a row written at nine would still claim 121 hours at noon.
-- `sla_end_time` is a fixed instant, so the countdown is arithmetic at the moment somebody
-- looks and is never stale. That is the whole difference between live and hourly.

CREATE TABLE IF NOT EXISTS fieldez_sla (
  -- The work order with case and punctuation removed, so WO-035640797, WO035640797 and
  -- wo-035640797 are one row rather than three. Everything joins on this.
  ticket_key         TEXT PRIMARY KEY,
  -- As FieldEZ writes it, for showing back to a person.
  ticket_no          TEXT NOT NULL,
  -- HP's case number. FieldEZ carries it in a generically-named custom slot, so it is copied
  -- here where its meaning is stated.
  case_id            TEXT NOT NULL DEFAULT '',

  -- FieldEZ's own row id and business process, which together address the ticket's page:
  -- /frontend/tlm/ticket-view/{bp_id}/{fieldez_ticket_id}/summary. Kept so a person can be
  -- sent straight to the source of a number they doubt.
  fieldez_ticket_id  BIGINT,
  bp_id              INTEGER,

  -- "Within SLA" / "SLA Breached". EMPTY IS A REAL ANSWER: plenty of tickets carry no SLA at
  -- all and their page shows a dash in every SLA field. Empty says "FieldEZ tracks no promise
  -- here", which is not the same as "the promise is being kept" and must not be counted as it.
  sla_status         TEXT NOT NULL DEFAULT '',
  -- Which promise applies — "Commercial", "Consumer".
  sla_policy         TEXT NOT NULL DEFAULT '',
  -- When it expires. NULL for a ticket with no SLA.
  sla_end_time       TIMESTAMPTZ,

  priority           TEXT NOT NULL DEFAULT '',
  -- Where the ticket had got to when this was read — "Partner Parts Hold". Useful next to a
  -- breach: a call that blew its SLA waiting for a part is a different problem from one that
  -- blew it waiting for an engineer.
  task_name          TEXT NOT NULL DEFAULT '',

  -- When FieldEZ was last asked. A row that stops being refreshed is a row whose SLA may have
  -- changed without anyone noticing, so the age of the answer is part of the answer.
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "What is about to breach" is the question this table exists to answer quickly.
CREATE INDEX IF NOT EXISTS fieldez_sla_end_time_idx
  ON fieldez_sla (sla_end_time)
  WHERE sla_end_time IS NOT NULL;

-- "How stale is this?" — for the worker's own bookkeeping and for saying so on screen.
CREATE INDEX IF NOT EXISTS fieldez_sla_fetched_idx ON fieldez_sla (fetched_at);
