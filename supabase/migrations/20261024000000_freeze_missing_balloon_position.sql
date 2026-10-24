BEGIN;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS frozen_position jsonb;

CREATE OR REPLACE FUNCTION public.mark_balloon_missing(p_owner_id uuid, p_device_id text, p_position jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE current_status text;
BEGIN
 SELECT status INTO current_status FROM public.devices
 WHERE device_id=p_device_id AND community_private.can_manage_balloon(p_owner_id,p_device_id) FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p_position IS NOT NULL AND (
   jsonb_typeof(p_position) <> 'object' OR
   jsonb_typeof(p_position->'lat') IS DISTINCT FROM 'number' OR
   jsonb_typeof(p_position->'lon') IS DISTINCT FROM 'number' OR
   jsonb_typeof(p_position->'t') IS DISTINCT FROM 'number'
 ) THEN RAISE EXCEPTION 'Invalid position' USING ERRCODE='22023'; END IF;
 IF p_position IS NOT NULL AND (
   (p_position->>'lat')::numeric NOT BETWEEN -90 AND 90 OR
   (p_position->>'lon')::numeric NOT BETWEEN -180 AND 180 OR
   (p_position->>'t')::numeric < 0
 ) THEN RAISE EXCEPTION 'Invalid position' USING ERRCODE='22023'; END IF;
 UPDATE public.devices SET status='missing',
 frozen_position=CASE WHEN current_status='flying' THEN p_position ELSE frozen_position END
 WHERE device_id=p_device_id;
 RETURN community_private.balloon_json(p_device_id);
END;
$$;
REVOKE ALL ON FUNCTION public.mark_balloon_missing(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mark_balloon_missing(uuid,text,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
