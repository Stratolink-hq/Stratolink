from pathlib import Path
import wx,pcbnew,json,hashlib
p=Path(__file__).resolve().parent;app=wx.App(False)
def xy(v):return[v.x,v.y]
def snap(path):
 b=pcbnew.LoadBoard(str(path));d={'fps':{},'pads':{},'tracks':{},'zones':{},'edges':{}}
 for f in b.GetFootprints():
  r=f.GetReference();d['fps'][r]={'at':xy(f.GetPosition()),'angle':f.GetOrientationDegrees(),'layer':f.GetLayerName(),'value':f.GetValue(),'lib':str(f.GetFPID().GetLibNickname())+':'+str(f.GetFPID().GetLibItemName())}
  for pad in f.Pads():
   d['pads'][pad.m_Uuid.AsString()]={'ref':r,'pin':pad.GetNumber(),'at':xy(pad.GetPosition()),'size':xy(pad.GetSize()),'drill':xy(pad.GetDrillSize()),'net':pad.GetNetname(),'shape':int(pad.GetShape()),'layers':pad.GetLayerSet().FmtHex(),'angle':pad.GetOrientationDegrees()}
 for t in b.GetTracks():
  v=isinstance(t,pcbnew.PCB_VIA);d['tracks'][t.m_Uuid.AsString()]={'type':t.GetClass(),'start':xy(t.GetStart()),'end':xy(t.GetEnd()),'width':t.GetWidth(pcbnew.F_Cu) if v else t.GetWidth(),'net':t.GetNetname(),'layer':t.GetLayerName(),'drill':t.GetDrillValue() if v else None}
 for z in b.Zones():
  d['zones'][z.m_Uuid.AsString()]={'net':z.GetNetname(),'priority':z.GetAssignedPriority(),'layer':z.GetLayerSet().FmtHex(),'rules':z.GetIsRuleArea(),'clearance':z.GetLocalClearance(),'thermal_gap':z.GetThermalReliefGap(),'thermal_width':z.GetThermalReliefSpokeWidth()}
 for e in b.GetDrawings():
  if e.GetLayer()==pcbnew.Edge_Cuts:d['edges'][e.m_Uuid.AsString()]={'type':e.GetShapeStr(),'start':xy(e.GetStart()),'end':xy(e.GetEnd()),'width':e.GetWidth()}
 return d
old=snap(p/'before/stratolink.kicad_pcb');new=snap(p/'candidate/stratolink.kicad_pcb');changes=json.load(open(p/'changes.json'))
result={'source_sha256':hashlib.sha256((p/'before/stratolink.kicad_pcb').read_bytes()).hexdigest(),'candidate_sha256':hashlib.sha256((p/'candidate/stratolink.kicad_pcb').read_bytes()).hexdigest()}
assert set(old['fps'])==set(new['fps']);moved=[]
for r,o in old['fps'].items():
 n=new['fps'][r]
 if o!=n:
  assert r in ['C15','R21','R11'];assert {k:v for k,v in o.items()if k!='at'}=={k:v for k,v in n.items()if k!='at'};moved.append({'ref':r,'before_nm':o['at'],'after_nm':n['at']})
assert set(x['ref']for x in moved)=={'C15','R21','R11'}
assert set(old['pads'])==set(new['pads'])
for u,o in old['pads'].items():
 n=new['pads'][u];assert {k:v for k,v in o.items()if k!='at'}=={k:v for k,v in n.items()if k!='at'},(u,o,n)
 if o['at']!=n['at']:assert o['ref']in ['C15','R21','R11']
removed=set(old['tracks'])-set(new['tracks']);added=set(new['tracks'])-set(old['tracks']);reshaped={u for u in set(old['tracks'])&set(new['tracks'])if old['tracks'][u]!=new['tracks'][u]}
assert removed=={x['uuid']for x in changes if x['action']=='remove_track'}
assert added=={x['uuid']for x in changes if x['action']in ['add_track','add_via']}
assert reshaped=={x['uuid']for x in changes if x['action']=='reshape_track'}
for u in reshaped:
 assert old['tracks'][u]['net']==new['tracks'][u]['net'];assert old['tracks'][u]['width']==new['tracks'][u]['width'];assert old['tracks'][u]['layer']==new['tracks'][u]['layer']
assert old['zones']==new['zones'];assert old['edges']==new['edges']
result.update(footprint_count=len(new['fps']),pad_count=len(new['pads']),moved=moved,removed_track_count=len(removed),added_tracks_and_vias=[new['tracks'][u]|{'uuid':u}for u in added],reshaped_track_count=len(reshaped),pad_nets_and_geometries_unchanged=True,old_vias_unchanged=True,zone_settings_unchanged=True,outline_unchanged=True)
(p/'scope-audit.json').write_text(json.dumps(result,indent=2)+'\n');print('scope pass',result['candidate_sha256'],moved,'removed',len(removed),'added',len(added),'reshaped',len(reshaped))
