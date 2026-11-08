from pathlib import Path
import wx,pcbnew,json,hashlib
root=Path(__file__).resolve().parents[3];out=Path(__file__).resolve().parent
app=wx.App(False);b=pcbnew.LoadBoard(str(root/'hardware/pcb/stratolink.kicad_pcb'))
M=pcbnew.ToMM
def xy(p):return [M(p.x),M(p.y)]
result={'footprints':[],'tracks':[],'drawings':[]}
for f in b.GetFootprints():
 ps=[p for p in f.Pads() if 52<=M(p.GetPosition().x)<=60 and 75<=M(p.GetPosition().y)<=84]
 if not ps and f.GetReference()!='U2':continue
 result['footprints'].append({'ref':f.GetReference(),'pos':xy(f.GetPosition()),'angle':f.GetOrientationDegrees(),'side':f.GetLayerName(),'pads':[{'n':p.GetNumber(),'pos':xy(p.GetPosition()),'size':xy(p.GetSize()),'net':p.GetNetname(),'layers':p.GetLayerSet().FmtHex()}for p in (f.Pads() if f.GetReference()!='U2' else ps)]})
for t in b.GetTracks():
 ps=[t.GetStart(),t.GetEnd()]
 if not any(52<=M(p.x)<=60 and 75<=M(p.y)<=84 for p in ps):continue
 result['tracks'].append({'uuid':t.m_Uuid.AsString(),'type':type(t).__name__,'start':xy(t.GetStart()),'end':xy(t.GetEnd()),'width':M(t.GetWidth(pcbnew.F_Cu) if isinstance(t,pcbnew.PCB_VIA) else t.GetWidth()),'layer':b.GetLayerName(t.GetLayer()),'net':t.GetNetname()})
for d in b.GetDrawings():
 if isinstance(d,pcbnew.PCB_SHAPE):
  ps=[d.GetStart(),d.GetEnd()]
  if any(52<=M(p.x)<=60 and 75<=M(p.y)<=84 for p in ps):result['drawings'].append({'type':d.GetShapeStr(),'start':xy(d.GetStart()),'end':xy(d.GetEnd()),'layer':d.GetLayerName()})
(out/'local-before.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
