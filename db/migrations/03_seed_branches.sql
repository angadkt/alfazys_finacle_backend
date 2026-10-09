INSERT INTO branches (id, name, is_active) OVERRIDING SYSTEM VALUE VALUES 
(1, 'UAE', true),
(2, 'INDIA', true)
ON CONFLICT (id) DO NOTHING;
