from pathlib import Path
import json,hashlib,sys
root=Path(__file__).resolve().parents[3];out=Path(__file__).resolve().parent
sys.path.insert(0,str(root/'analysis/v1_1_solar_attachments_20261012/layout'));import cad_helpers as a
src=root/'hardware/pcb';expected={'stratolink.kicad_pcb':'532dfc743b315fc4957f4f9cbb4b5d580ec4ca996b48c89840083dfbd979faf0','stratolink.kicad_sch':'092ddb3451545cc6f7d7d64d8c02c933e89a40acb6897d865e3a8936d54e21fb'}
def sha(b):return hashlib.sha256(b).hexdigest()
def r1(data,kind):
 for n in a.nodes(a.parse(data),kind):
  props={str(x[1]):str(x[2])for x in a.nodes(n,'property')}
  if props.get('Reference')=='R1':return props
 raise AssertionError('R1 missing')
updates={'Datasheet':'https://www.tme.eu/Document/4f50d320a6ddacb273098f84373b6259/rezystor-smd.pdf','Description':'0402WGF7504TCE; 7.50 MΩ, 1%, 100 ppm/°C charge-ceiling resistor','Manufacturer':'UNI-ROYAL','Manufacturer_Part_Number':'0402WGF7504TCE','LCSC':'C423135','Supplier Part':'C423135','MPN':'0402WGF7504TCE','LCSC Part #':'C423135'}
prepared={};audit={'substitution':'R1 only: FOJAN FRC0402F7504TS / C3013187 to UNI-ROYAL 0402WGF7504TCE / C423135','technical_gate':'Parent confirmed manufacturer-authored datasheet review and package compatibility on 2026-11-08. Value, circuit, and all geometry remain unchanged.','files':{}}
for name,digest in expected.items():
 path=src/name;raw=path.read_bytes();assert sha(raw)==digest,('Source hash changed',name);text=raw.decode();props=r1(text,'footprint'if name.endswith('pcb')else'symbol');new=text;operations=[]
 for k,v in updates.items():
  token='(property '+json.dumps(k,ensure_ascii=False)+' '+json.dumps(props[k],ensure_ascii=False)
  assert text.count(token)==1,(name,k,text.count(token));replacement='(property '+json.dumps(k,ensure_ascii=False)+' '+json.dumps(v,ensure_ascii=False);index=new.index(token);operations.append((index,token,replacement));new=new[:index]+replacement+new[index+len(token):]
 result=r1(new,'footprint'if name.endswith('pcb')else'symbol');assert {k:v for k,v in result.items()if k not in updates}=={k:v for k,v in props.items()if k not in updates};assert all(result[k]==v for k,v in updates.items())
 # Full-file reversibility proves that no routing, geometry, schematic, or formatting changed outside those eight strings.
 reverse=new
 for index,token,replacement in reversed(operations):
  assert reverse[index:index+len(replacement)]==replacement;reverse=reverse[:index]+token+reverse[index+len(replacement):]
 assert reverse==text
 (out/'before').mkdir(exist_ok=True);(out/'after').mkdir(exist_ok=True)
 if (out/'before'/name).exists():assert (out/'before'/name).read_bytes()==raw,'Existing provenance differs'
 else:(out/'before'/name).write_bytes(raw)
 if (out/'after'/name).exists():assert (out/'after'/name).read_text()==new,'Existing candidate differs'
 else:(out/'after'/name).write_text(new)
 prepared[name]=new.encode();audit['files'][name]={'before_sha256':digest,'after_sha256':sha(prepared[name]),'properties':{k:{'before':props[k],'after':v}for k,v in updates.items()},'full_file_reverse_check':True}
# All sources guarded before any canonical write.
for name,digest in expected.items():assert sha((src/name).read_bytes())==digest
for name,data in prepared.items():(src/name).write_bytes(data)
(out/'property-diff.json').write_text(json.dumps(audit,indent=2,ensure_ascii=False)+'\n');print(json.dumps({name:{k:v for k,v in info.items()if 'sha256'in k}for name,info in audit['files'].items()},indent=2))
