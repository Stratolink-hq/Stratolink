from pathlib import Path
import wx,pcbnew,json,uuid,math,re,shutil
root=Path(__file__).resolve().parents[3];out=Path(__file__).resolve().parent;cand=out/'candidate'
raw=(out/'before/stratolink.kicad_pcb').read_text()
while '(filled_polygon' in raw:
 start=raw.index('(filled_polygon');depth=0
 for end in range(start,len(raw)):
  if raw[end]=='(':depth+=1
  elif raw[end]==')':
   depth-=1
   if depth==0:break
 raw=raw[:start]+raw[end+1:]
(cand/'stratolink.kicad_pcb').write_text(raw)
shutil.copy2(out/'before/stratolink.kicad_pro',cand/'stratolink.kicad_pro')
app=wx.App(False);b=pcbnew.LoadBoard(str(cand/'stratolink.kicad_pcb'));fps={f.GetReference():f for f in b.GetFootprints()};keep_removed=[]
def pt(x,y):return pcbnew.VECTOR2I(round(x*1e6),round(y*1e6))
def xy(p):return[p.x/1e6,p.y/1e6]
changes=[]
for ref,x in [('C15',56.03),('R21',56.0)]:
 f=fps[ref];prev=xy(f.GetPosition());f.SetPosition(pt(x,prev[1]));changes.append({'action':'move_footprint','ref':ref,'before':prev,'after':xy(f.GetPosition()),'angle':f.GetOrientationDegrees()})
f=fps['R11'];prev=xy(f.GetPosition());f.SetPosition(pt(prev[0],prev[1]-.35));changes.append({'action':'move_footprint','ref':'R11','before':prev,'after':xy(f.GetPosition()),'angle':f.GetOrientationDegrees()})
# Replace only the local PA15 sense branch; retain the U2 approach outside this region.
remove={'10bb59b4-e587-413c-b332-41e6d31e6575','2439b807-2821-48c6-83cf-b6416aa737bf','7dd2d7b0-3048-443d-96f5-55a4675da4d4','7fdcf3b9-89d2-4c65-b596-3e47500026a6','93cc4261-e593-43c8-adc9-1306fcf4a326','a9277179-2eab-4db2-8473-680e69d770cb','b16f03ec-3f50-4afe-97c6-47942a36e595'}
found=set()
for t in list(b.GetTracks()):
 u=t.m_Uuid.AsString()
 if u in remove:
  assert t.GetNetname()=='PA15';changes.append({'action':'remove_track','uuid':u,'start':xy(t.GetStart()),'end':xy(t.GetEnd())});keep_removed.append(t);b.Remove(t);found.add(u)
assert found==remove
path=[(60.68,78.1),(56.810998,78.1),(56.51,78.400998),(56.51,79.546999),(56.51,79.8),(57.19,80.48),(57.19,80.65)]
code=b.FindNet('PA15').GetNetCode()
for i,(p,q) in enumerate(zip(path,path[1:])):
 t=pcbnew.PCB_TRACK(b);t.SetStart(pt(*p));t.SetEnd(pt(*q));t.SetWidth(300000);t.SetLayer(pcbnew.F_Cu);t.SetNetCode(code);b.Add(t);changes.append({'action':'add_track','uuid':t.m_Uuid.AsString(),'start':p,'end':q,'width':.3,'net':'PA15'})
# Make room for the moved grounded pads while preserving the original 45-degree RST approach.
rst={'48267670-c5a3-4dce-8e49-304fb954be98':((54.85,82.64),(54.85,78.07)), '4d5ad7ae-8c3a-40c9-a47e-b80bbe8bf3cb':((57.83,85.62),(54.85,82.64)), 'b4a99526-56b5-44bb-8d34-afa710a66774':((54.85,78.07),(55.6,77.32)), 'c8b1d8b5-f788-4a6a-b72b-8bbe6bc689d8':((55.6,77.32),(60.95,77.32))}
for t in b.GetTracks():
 u=t.m_Uuid.AsString()
 if u in rst:
  assert t.GetNetname()=='RST';changes.append({'action':'reshape_track','uuid':u,'before':[xy(t.GetStart()),xy(t.GetEnd())],'after':rst[u]});t.SetStart(pt(*rst[u][0]));t.SetEnd(pt(*rst[u][1]))
# R11 moves upward by 0.35 mm for conservative GNSS residual-tab allowance.
r11_remove={'0d9ed415-00a3-464a-b21b-eb3f0a98c2ed','e2d2f23b-4027-4fcd-adf0-bd74dae6e23a','600ed2f2-c677-4c0a-96df-57790af1cc48','08e40b1f-b525-4b7d-a35d-fceb04f0b4b1','89f52c67-3a90-4191-bdf4-b979f5edecfd','d8871904-c9ce-4527-9506-8a2b5ed1691f'}
for t in list(b.GetTracks()):
 if t.m_Uuid.AsString() in r11_remove:
  assert t.GetNetname()=='SDA';changes.append({'action':'remove_track','uuid':t.m_Uuid.AsString(),'start':xy(t.GetStart()),'end':xy(t.GetEnd())});keep_removed.append(t);b.Remove(t)
for p,q in [((67.71,41.55),(68.149999,41.55)),((68.149999,41.55),(68.439999,41.84))]:
 t=pcbnew.PCB_TRACK(b);t.SetStart(pt(*p));t.SetEnd(pt(*q));t.SetWidth(200000);t.SetLayer(pcbnew.F_Cu);t.SetNetCode(b.FindNet('SDA').GetNetCode());b.Add(t);changes.append({'action':'add_track','uuid':t.m_Uuid.AsString(),'start':p,'end':q,'width':.2,'net':'SDA'})
r11_vcc={'25fc811c-ed51-4b7d-a45f-c877f9398291':((69.880001,42.26),(69.460001,41.84)), '70fcd490-85da-47c9-ba4d-0efae95db56a':((72.044314,42.26),(69.880001,42.26))}
for t in b.GetTracks():
 u=t.m_Uuid.AsString()
 if u in r11_vcc:
  assert t.GetNetname()=='+3.3V';changes.append({'action':'reshape_track','uuid':u,'before':[xy(t.GetStart()),xy(t.GetEnd())],'after':r11_vcc[u]});t.SetStart(pt(*r11_vcc[u][0]));t.SetEnd(pt(*r11_vcc[u][1]))
# Join the two SDA branches locally after clearing the lifted R11 pad.
v=pcbnew.PCB_VIA(b);v.SetPosition(pt(66.9,42.8));v.SetWidth(500000);v.SetDrill(300000);v.SetViaType(next(t for t in b.GetTracks() if isinstance(t,pcbnew.PCB_VIA)).GetViaType());v.SetLayerPair(pcbnew.F_Cu,pcbnew.B_Cu);v.SetNetCode(b.FindNet('SDA').GetNetCode());b.Add(v);changes.append({'action':'add_via','uuid':v.m_Uuid.AsString(),'position':[66.9,42.8],'diameter':.5,'drill':.3,'net':'SDA'})
for p,q,layer in [((66.71,42.8),(66.9,42.8),pcbnew.F_Cu),((66.9,42.8),(66.9,43.053),pcbnew.B_Cu)]:
 t=pcbnew.PCB_TRACK(b);t.SetStart(pt(*p));t.SetEnd(pt(*q));t.SetWidth(200000);t.SetLayer(layer);t.SetNetCode(b.FindNet('SDA').GetNetCode());b.Add(t);changes.append({'action':'add_track','uuid':t.m_Uuid.AsString(),'start':p,'end':q,'layer':b.GetLayerName(layer),'width':.2,'net':'SDA'})
geom=json.loads((out/'outlines.json').read_text())
for ref,info in geom.items():
 if ref!='U2':
  shutil.copy2(out/'before/lib'/info['filename'],cand/'lib'/info['filename']);continue
 f=fps[ref];angle=math.radians(f.GetOrientationDegrees());origin=xy(f.GetPosition());liblines=[]
 for kind,layer,width in [('fab',pcbnew.F_Fab,.1),('courtyard',pcbnew.F_CrtYd,.05)]:
  points=info[kind]
  for i,(p,q) in enumerate(zip(points,points[1:])):
   ident=str(uuid.uuid5(uuid.NAMESPACE_URL,f'stratolink-v1.1-resubmit-20261108/{ref}/{kind}/{i}'))
   def world(p):return pt(origin[0]+p[0]*math.cos(angle)+p[1]*math.sin(angle),origin[1]-p[0]*math.sin(angle)+p[1]*math.cos(angle))
   s=pcbnew.PCB_SHAPE(f);s.SetShape(pcbnew.SHAPE_T_SEGMENT);s.SetStart(world(p));s.SetEnd(world(q));s.SetLayer(layer);s.SetWidth(round(width*1e6));f.Add(s)
   liblines.append(f'\t(fp_line (start {p[0]:.6f} {p[1]:.6f}) (end {q[0]:.6f} {q[1]:.6f}) (stroke (width {width}) (type solid)) (layer "'+('F.Fab' if kind=='fab' else 'F.CrtYd')+f'") (uuid "{ident}"))')
 file=cand/'lib'/info['filename'];s=(out/'before/lib'/info['filename']).read_text();file.write_text(s.rstrip()[:-1]+'\n'+'\n'.join(liblines)+'\n)\n')
 if ref=='U2':
  d='RAK3172 no-IPEX 32-pad LoRa module; 15.5 x 15 mm nominal body; body/pad courtyard restored for assembly clearance review'
  f.SetLibDescription(d);s=file.read_text();s=s.replace('RAK4260 LoRaWAN module from RAKwireless.',d);file.write_text(s)
 changes.append({'action':'add_assembly_outlines','ref':ref,**info})
b.BuildConnectivity();pcbnew.SaveBoard(str(cand/'stratolink.kicad_pcb'),b)
shutil.copy2(out/'before/stratolink.kicad_pro',cand/'stratolink.kicad_pro')
(out/'changes.json').write_text(json.dumps(changes,indent=2)+'\n')
print('Candidate written with',len(changes),'scoped changes')
