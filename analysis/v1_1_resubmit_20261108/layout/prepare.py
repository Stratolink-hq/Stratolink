from pathlib import Path
import sys,json,hashlib,shutil
from shapely.geometry import box
from shapely.ops import unary_union
root=Path(__file__).resolve().parents[3];out=Path(__file__).resolve().parent
sys.path.insert(0,str(root/'analysis/v1_1_solar_attachments_20261012/layout'));import cad_helpers as a
src=root/'hardware/pcb';before=out/'before';cand=out/'candidate'
assert not before.exists() and not cand.exists()
before.mkdir();cand.mkdir()
files=['stratolink.kicad_pcb','stratolink.kicad_sch','stratolink.kicad_pro','stratolink.kicad_dru','fp-lib-table','sym-lib-table']
manifest={}
for n in files:
 data=(src/n).read_bytes();(before/n).write_bytes(data);(cand/n).write_bytes(data);manifest[n]=hashlib.sha256(data).hexdigest()
shutil.copytree(src/'lib',cand/'lib');(cand/'3d').symlink_to(src/'3d')
geom={}
for ref in ['U2','C15','R21']:
 name=next(p.name for p in (src/'lib').glob('Stratolink_v1p1_'+ref+'_*.kicad_mod'))
 (before/'lib').mkdir(exist_ok=True);shutil.copy2(src/'lib'/name,before/'lib'/name)
 manifest['lib/'+name]=hashlib.sha256((src/'lib'/name).read_bytes()).hexdigest()
 f=a.parse((src/'lib'/name).read_text());pads=[]
 for p in a.nodes(f,'pad'):
  x,y,*_=a.floats(p,'at');w,h=a.floats(p,'size');x=round(x,3);y=round(y,3);pads.append(box(x-w/2,y-h/2,x+w/2,y+h/2))
 if ref=='U2':
  fab=[(0,0),(15.5,0),(15.5,-15),(0,-15),(0,0)]
  # Union of model and supplier-center nominal registration, plus actual lands.
  env=unary_union([box(0,-15.045,15.515,0),*pads]).buffer(.15,join_style=2).simplify(.00001,preserve_topology=True)
  court=list(env.exterior.coords)
 else:
  b=unary_union(pads).bounds;court=list(box(b[0]-.15,b[1]-.15,b[2]+.15,b[3]+.15).exterior.coords);fab=[]
 geom[ref]={'filename':name,'fab':fab,'courtyard':[[round(x,6),round(y,6)]for x,y in court],'courtyard_excess_mm':.15}
(out/'input-hashes.json').write_text(json.dumps(manifest,indent=2)+'\n');(out/'outlines.json').write_text(json.dumps(geom,indent=2)+'\n')
print('Prepared baseline and candidate; outlines:',{k:len(v['courtyard'])-1 for k,v in geom.items()})
