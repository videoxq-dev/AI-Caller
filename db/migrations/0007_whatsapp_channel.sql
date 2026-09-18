CREATE UNIQUE INDEX "integrations_whatsapp_phone_number_id_uq"
ON "integrations" (("settings" ->> 'phoneNumberId'))
WHERE "provider" = 'whatsapp' AND ("settings" ? 'phoneNumberId');
