-- Migration 15: Guarantee Super Admin credentials (infazyss@gmail.com / Infaz@1010)
DO $$
DECLARE
    target_id BIGINT;
    pwd_hash TEXT := '$argon2id$v=19$m=65536,p=4,t=3$MtxidravKNDYiE+xQ6N1ow$knGYfoNNC51owea1R1bepoA60ttK34k41vfFIfcN5BI';
BEGIN
    -- 1. If infazyss@gmail.com already exists, update password, role and ensure active
    IF EXISTS (SELECT 1 FROM users WHERE email = 'infazyss@gmail.com') THEN
        UPDATE users 
        SET password_hash = pwd_hash,
            role = 'admin',
            is_active = TRUE
        WHERE email = 'infazyss@gmail.com'
        RETURNING id INTO target_id;

        -- Remove legacy email if duplicate row exists
        DELETE FROM users WHERE email = 'infazyssuperadmin@gmail.com';

    ELSIF EXISTS (SELECT 1 FROM users WHERE email = 'infazyssuperadmin@gmail.com') THEN
        -- 2. Otherwise update old infazyssuperadmin@gmail.com
        UPDATE users 
        SET email = 'infazyss@gmail.com',
            password_hash = pwd_hash,
            role = 'admin',
            is_active = TRUE
        WHERE email = 'infazyssuperadmin@gmail.com'
        RETURNING id INTO target_id;

    ELSIF EXISTS (SELECT 1 FROM users WHERE role = 'admin') THEN
        -- 3. If any admin exists, update that admin
        UPDATE users 
        SET email = 'infazyss@gmail.com',
            password_hash = pwd_hash,
            is_active = TRUE
        WHERE id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1)
        RETURNING id INTO target_id;

    ELSE
        -- 4. Otherwise insert new super admin
        INSERT INTO users (full_name, email, password_hash, role, is_active)
        VALUES ('Super Admin', 'infazyss@gmail.com', pwd_hash, 'admin', TRUE)
        RETURNING id INTO target_id;
    END IF;

    -- Ensure all module permissions are granted
    INSERT INTO user_permissions (user_id, module, level)
    SELECT target_id, m, 'edit'::access_level
    FROM unnest(ENUM_RANGE(NULL::module_name)) AS m
    ON CONFLICT (user_id, module) DO UPDATE SET level = 'edit';
END $$;

