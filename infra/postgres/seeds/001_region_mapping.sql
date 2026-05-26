INSERT INTO regions (code, name)
VALUES
  ('ASPS01461', 'Chennai'),
  ('ASPS01463', 'Vellore'),
  ('ASPS01465', 'Salem'),
  ('ASPS01489', 'Kanchipuram'),
  ('ASPS01511', 'Hosur')
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name;
