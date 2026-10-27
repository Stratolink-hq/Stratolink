import assert from 'node:assert/strict';

// Synthetic legacy uplinks in the disposable backend test database.
export function checkRegionalTelemetry({ sql, service, literal, hash }) {
  const owner = '40000000-0000-4000-8000-000000000001';
  sql(`INSERT INTO auth.users(id) VALUES('${owner}');`);
  const staff = service(`INSERT INTO community_private.webhook_integrations(cluster,application_id,token_hash) VALUES('eu1','regional-staff-app','${hash('regional-staff-token')}') RETURNING id;`);
  service(`SELECT public.bind_staff_payload_radio('stratolink-3','${staff}','eu1','regional-staff-app','stratolink-3-eu','70B3D57ED00778CA','EU_863_870_TTN');`);
  // A community payload names its TTN device after an official regional id.
  const imitator = JSON.parse(service(`SELECT public.register_community_balloon('${owner}','regional-user','Regional imitator','70B3D57ED0078832')`));
  service(`SELECT public.connect_community_radio('${owner}',${literal(imitator.id)},'eu1','imitator-app','stratolink-2-eu','70B3D57ED0078832','EU_863_870_TTN','${hash('imitator-token')}')`);
  sql(`UPDATE public.devices SET connection_status='connected' WHERE device_id=${literal(imitator.id)};`);
  service(`INSERT INTO public.telemetry(device_id,time,lat,lon,telemetry_version) VALUES
    ('stratolink-3-eu','2026-05-28 08:00:00Z',40.3,-6.9,2),
    ('stratolink-3-eu','2026-05-28 09:00:00Z',40.6,-6.4,2),
    ('stratolink-2-eu','2026-05-28 10:00:00Z',40.5,-5.3,2),
    ('unbound-legacy-id','2026-05-28 11:00:00Z',40.5,-5.3,2);`);

  const visible = id => service(`SELECT count(*) FROM public.community_telemetry WHERE device_id=${literal(id)}`);
  assert.equal(visible('stratolink-3-eu'), '2');
  assert.equal(visible('stratolink-2-eu'), '0');
  assert.equal(visible('unbound-legacy-id'), '0');
  assert.equal(service("SELECT count(*) FROM public.community_telemetry WHERE device_id IN('stratolink-3','stratolink-3-eu')"),
    String(Number(service("SELECT count(*) FROM public.telemetry WHERE device_id='stratolink-3'")) + 2));
  console.log('PASS: legacy regional uplinks reach public telemetry only through staff radio identities');
}
