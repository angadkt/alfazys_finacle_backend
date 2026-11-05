-- Migration 14: Update Super Admin email to infazyss@gmail.com and password to Infaz@1010
UPDATE users 
SET email = 'infazyss@gmail.com',
    password_hash = '$argon2id$v=19$m=65536,p=4,t=3$MtxidravKNDYiE+xQ6N1ow$knGYfoNNC51owea1R1bepoA60ttK34k41vfFIfcN5BI'
WHERE role = 'admin';
