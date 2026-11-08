from pathlib import Path
import json,csv,math,itertools,sys
root=Path(__file__).resolve().parents[3];out=Path(__file__).resolve().parent
inp=Path(sys.argv[1]) if len(sys.argv)>1 else out/'baseline-native.json'
j=json.loads(inp.read_text());rows={r['Designator']:r for r in csv.DictReader((root/'hardware/gerbers/v1.1-final-20261016/BOM-stratolink.csv').open())}
# axis dims at the current board pose for ICs; passive axes follow native angle.
ic={'U1':([3.5,3.5],[3.65,3.65]),'U2':([15.5,15],[15.6,15.1]),'U3':([9.7,10.1],[9.8,11.9]),'U4':([3,5],[3.1,5.1]),'U5':([.95,1.48],[1.0,1.53]),'U7':([2,2],[2.15,2.15]),'U8':([2.8,2.9],[3.0,3.05])}
parts={}
for ref,row in rows.items():
 f=j['footprints'][ref];x,y=f['at'];a=f['angle'];maxd=None
 if ref in ic:
  dims,maxd=ic[ref]
  if ref=='U2':
   assert a==180.0, 'Rebuild U2 registration for changed rotation'
   x,y=x-7.7575,y+7.5225
   dims,maxd=[15.515,15.045],[15.615,15.145] # union of two model/CPL registrations plus 0.05mm screening halo
 elif ref[0]=='R':dims=([2,1.25] if ref=='R27' else [1.0,.5]);maxd=([2.1,1.4] if ref=='R27' else ([1.05,.55] if row['Comment'].startswith(('RC0402','CRCW0402')) else [1.15,.65]))
 elif ref[0]=='C':
  if '_0402_' in row['Footprint']:dims,maxd=[1,.5],([1.15,.65] if ref=='C1' else [1.05,.55])
  elif '_0603_' in row['Footprint']:dims,maxd=[1.6,.8],[1.7,.9]
  elif '_0805_' in row['Footprint']:dims,maxd=[2,1.25],[2.2,1.45]
  else:raise Exception(ref)
 elif ref=='FB1':dims,maxd=[1,.5],[1.05,.55]
 elif ref in ['D1','D3']:dims,maxd=[1.6,.8],[1.7,.9] # include terminals for SOD523 screen
 elif ref=='L1':dims,maxd=[4,4],[4.2,4.2]
 elif ref=='L2':dims,maxd=[1.6,.8],[1.8,1.0]
 else:raise Exception(ref)
 if ref not in ic and abs(round(a/90))%2:dims=dims[::-1];maxd=maxd[::-1]
 def bb(d):return [x-d[0]/2,y-d[1]/2,x+d[0]/2,y+d[1]/2]
 parts[ref]={'mpn':row['Comment'],'layer':f['layer'],'nominal_mm':dims,'screen_mm':maxd,'nominal_box':bb(dims),'screen_box':bb(maxd)}
def gap(a,b):
 dx=max(a[0]-b[2],b[0]-a[2],0);dy=max(a[1]-b[3],b[1]-a[3],0)
 return math.hypot(dx,dy)
pairs=[]
for a,b in itertools.combinations(parts,2):
 if parts[a]['layer']!=parts[b]['layer']:continue
 pairs.append({'a':a,'b':b,'nominal_gap_mm':gap(parts[a]['nominal_box'],parts[b]['nominal_box']),'screen_gap_mm':gap(parts[a]['screen_box'],parts[b]['screen_box'])})
pairs.sort(key=lambda p:p['screen_gap_mm']);report={'source_sha256':j['sha256'],'parts':parts,'pairs':pairs,'warning':'Initial dimensional screen assumptions, not manufacturer tolerance-certified inventory. U2 registration uses existing model origin and nominal 15.5x15 body. Check sources before final acceptance.'}
(out/(inp.stem+'-screen.json')).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(pairs[:25],indent=2))
