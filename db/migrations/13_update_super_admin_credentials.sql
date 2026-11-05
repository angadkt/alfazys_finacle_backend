-- Migration 13: Update Super Admin email and password credentials
UPDATE users 
SET email = 'infazyssuperadmin@gmail.com',
    password_hash = '$argon2id$v=19$m=65536,p=4,t=3$/ZNlEvm8YbcmIn1ifCeJ7A$RCqW9HaUum42XCLJmnPDjYFvO/MuKdhn+vP+OKyHTTI'
WHERE role = 'admin';

