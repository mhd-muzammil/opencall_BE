-- The four remaining branch offices.
--
-- Migration 043 created region_offices but could only seed Chennai — the other
-- coordinates had not been supplied, and a guessed origin would silently mis-rank
-- every call in that region. These are the real office locations, supplied
-- 2026-08-14. Seeding them is all it takes for the Distance column to appear for
-- these regions: the generator computes from whatever offices exist, and the
-- frontend offers the column wherever the loaded report carries distances.
--
-- ON CONFLICT DO NOTHING (same as the Chennai seed): if a coordinate is ever
-- corrected by hand in the table, a re-run must not put the old value back.

INSERT INTO region_offices (asp_code, label, latitude, longitude)
VALUES
  ('ASPS01463', 'Vellore',     12.968108, 79.150375),
  ('ASPS01465', 'Salem',       11.670312, 78.142258),
  ('ASPS01489', 'Kanchipuram', 12.818904, 79.695457),
  ('ASPS01511', 'Hosur',       12.724307, 77.825411)
ON CONFLICT (asp_code) DO NOTHING;
