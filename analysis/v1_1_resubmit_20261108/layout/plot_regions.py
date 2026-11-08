from pathlib import Path
import json
import matplotlib;matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import PathPatch,Rectangle
from matplotlib.path import Path as MPath
from shapely.geometry import Polygon,box
from shapely import make_valid
p=Path(__file__).resolve().parent
boards=[json.loads((p/'copper-before.json').read_text()),json.loads((p/'copper.json').read_text())]
def polys(g):
 if g.geom_type=='Polygon' and not g.is_empty:yield g
 elif hasattr(g,'geoms'):
  for x in g.geoms:yield from polys(x)
def patch(poly,color,alpha=1):
 rings=[poly.exterior,*poly.interiors];verts=[];codes=[]
 for r in rings:
  pts=list(r.coords);verts.extend(pts);codes.extend([MPath.MOVETO]+[MPath.LINETO]*(len(pts)-2)+[MPath.CLOSEPOLY])
 return PathPatch(MPath(verts,codes),facecolor=color,edgecolor='none',alpha=alpha)
def draw(ax,d,layer,bounds,index,region):
 clip=box(*bounds)
 for item in sorted(d['items'],key=lambda i:i['kind']!='zone'):
  if item['layer']!=layer:continue
  net=item['net'];color={'GND':'#c9d3c8','PA15':'#da7e22','RST':'#ce4851','SDA':'#8550bc','SCL':'#3c8da8','+3.3V':'#c43e52'}.get(net,'#b08772')
  for poly in item['polygons']:
   geom=make_valid(Polygon(poly['shell'],poly['holes'])).intersection(clip)
   for x in polys(geom):ax.add_patch(patch(x,color,.93))
 for dr in d['drills']:
  x,y=dr['at'];a,b=dr['size_mm'];
  if bounds[0]<=x<=bounds[2] and bounds[1]<=y<=bounds[3]:ax.add_patch(plt.Circle((x,y),a/2,color='white',zorder=6))
 if layer=='F.Cu':
  if region=='u2':
   bodies=[('U2',57.20,64.66,15.515,15.045),('C15',(56.709998 if index==0 else 56.03)-.5,78.400998-.25,1,.5),('R21',(56.698999 if index==0 else 56)-.525,79.546999-.27,1.05,.54),('R19',56.679999-.525,80.65-.27,1.05,.54)]
  else:bodies=[('U3 tab allowance',66.23-4.9,48.4-5.95,9.8,11.9),('R11',68.95-.525,(42.19 if index==0 else 41.84)-.27,1.05,.54)]
  for label,x,y,w,h in bodies:
   ax.add_patch(Rectangle((x,y),w,h,facecolor='#f1f1f1',edgecolor='#1d2733',lw=1.3,alpha=.72,zorder=7))
   tx=min(max(x+w/2,bounds[0]+.6),bounds[2]-.7);ty=min(max(y+h/2,bounds[1]+.4),bounds[3]-.25)
   ax.text(tx,ty,label,ha='center',va='center',fontsize=8,zorder=8)
 ax.set_xlim(bounds[0],bounds[2]);ax.set_ylim(bounds[3],bounds[1]);ax.set_aspect('equal');ax.set_xlabel('x / mm');ax.set_ylabel('y / mm');ax.grid(alpha=.17);ax.set_title(('original' if index==0 else'corrected')+' | '+layer)
for region,bounds in [('u2',(53.7,76.6,61.5,81.5)),('r11',(65.6,40.8,71,44.2))]:
 rows=2 if region=='r11'else 1;fig,axes=plt.subplots(rows,2,figsize=(13,8 if rows==2 else 5.3),squeeze=False)
 for row in range(rows):
  for col in range(2):draw(axes[row,col],boards[col],['F.Cu','B.Cu'][row],bounds,col,region)
 fig.suptitle('C15/R21 clearance and local RST route'if region=='u2'else'R11 clearance, SDA join, and ground continuity',fontsize=14)
 fig.text(.5,.02,'native saved copper; body outlines shown for assembly clearance. orange PA15 / purple SDA / cyan SCL / red RST or 3.3 V / grey-green GND',ha='center',fontsize=9)
 fig.tight_layout(rect=(0,.05,1,.95));fig.savefig(p/(region+'-before-after.png'),dpi=180);plt.close(fig)
