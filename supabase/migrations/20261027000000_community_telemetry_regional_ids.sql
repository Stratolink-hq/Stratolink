BEGIN;
-- Uplinks stored before the radio-identity webhook kept the raw TTN device id
-- (stratolink-3-eu for a packet heard on the EU cluster) and no radio identity,
-- so the devices join hid them from the public map. Resolve those legacy rows
-- through the staff radio identities that now bind each regional TTN id to its
-- balloon. Owner integrations are excluded: a community TTN device cannot claim
-- official history by reusing a regional name.
CREATE OR REPLACE VIEW public.community_telemetry WITH (security_invoker = true) AS
SELECT t.* FROM public.telemetry t
INNER JOIN public.devices d ON d.device_id = CASE WHEN t.radio_identity_id IS NULL THEN coalesce((
  SELECT r.device_id FROM community_private.radio_identities r
  JOIN community_private.webhook_integrations w ON w.id = r.integration_id
  WHERE r.ttn_device_id = t.device_id AND w.owner_id IS NULL
  ORDER BY r.verified_at, r.id LIMIT 1
), t.device_id) ELSE t.device_id END
WHERE d.connection_status = 'connected';
REVOKE ALL ON TABLE public.community_telemetry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.community_telemetry TO service_role;
COMMIT;
