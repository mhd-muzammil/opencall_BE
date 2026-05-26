INSERT INTO regions (code, name, is_active)
VALUES
  ('ASPS01461', 'Chennai', TRUE),
  ('ASPS01463', 'Vellore', TRUE),
  ('ASPS01465', 'Salem', TRUE),
  ('ASPS01489', 'Kanchipuram', TRUE),
  ('ASPS01511', 'Hosur', TRUE)
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  is_active = TRUE;
