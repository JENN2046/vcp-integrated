"""Recheck the single shared Work against both launches on the three physical endpoints."""
import json,hashlib
from pathlib import Path
base=Path(__file__).resolve().parent
def get(rel):return json.loads((base/rel).read_text())
def sha(text):return hashlib.sha256(text.encode()).hexdigest()
def size(text):return len(text.encode())
fixed='c1b8ffc6272f64626fc6465434372bcb632aabe4'
tree='81b3497e17deba0313b0edd7123067dafdb11cda'
first=get('central/completed-facts.json')
last=get('central/reopened-facts.json')
assert first==last
view=last['view']; topic=last['sharedTopicId']; work,=view['work']; req=work['id']
assert get('central/before.json')['work']==[] and view['paired']==1
assert view['providerCalls']==view['totalProviderRequests']==work['attempts']==work['request_dispatched']==1
assert work['state']=='completed' and view['released']
calls=last['provider'];assert len(calls)==1 and calls[0]['case']=='lostAck' and calls[0]['id']==req
rows=last['journal'];ids=[row['id'] for row in rows]
assert ids==[work['user_message_id'],work['reply_message_id']]
assert rows[0]['id']==work['request_id']
bodies=[row['body'] for row in rows];roles=['user','assistant']
assert [row['seq'] for row in rows]==[1,2] and [row['role'] for row in rows]==roles
assert bodies==['Send-recovery compare 02: accept exactly once.','合成回复完成。']
assert all(row['action']=='upsert' for row in rows)
held=get('central/work-held.json'); hw,=held['work']
assert hw['id']==req and hw['state']=='running' and held['totalProviderRequests']==1
lps=[];wps=[];aps=[];modules=[]
def checkrows(items):assert [x['id'] for x in items]==ids
for prefix in ('initial','reopened'):
 lin=get('linux/'+prefix+'-readback.json')['value']
 assert lin['work']['id']==req and lin['work']['requestId']==work['request_id'] and lin['work']['state']=='completed'
 assert lin['scope']['topicId']==get('central/topic.json')['desktopDescriptor']['topicId']
 checkrows(lin['messages'])
 for j,body,role in zip(lin['messages'],bodies,roles):
  assert j['role']==role
  assert j['history']==dict(utf8Bytes=size(body),sha256=sha(body))
  assert j['dom']==dict(utf8Bytes=size(body+'\n'),sha256=sha(body+'\n'))
 lp=lin['pid']; lps.append(lp)
 assert get('linux/'+prefix+'-exit.json')['value']==dict(pid=lp,code=0,signal=None)
 native=get('linux/'+prefix+'-native.json');assert native['electron']['pid']==lp
for prefix in ('first','reopened'):
 win=get('windows/'+prefix+'.json')
 assert win['candidate']==fixed and win['sharedTopicId']==topic and win['work']['id']==req and win['work']['state']=='completed'
 assert win['sendAttempts']==0
 checkrows(win['dom']);checkrows(win['history'])
 for dom,h,body,role in zip(win['dom'],win['history'],bodies,roles):
  assert dom['text']==body and dom['visible'] and h['role']==role
  assert h['sha256']==dom['sha256']==sha(body) and h['bytes']==size(body)
 wps.append(win['electron']['pid'])
baseline=get('android/02-readonly-baseline.json')
assert baseline['observed']['topicKey']==topic and baseline['observed']['messages']==[]
for mobilefile,modulefile in [('03-terminal','02-loaded-module'),('05-cold','06-cold-loaded-module')]:
 mob=get('android/'+mobilefile+'.json'); src=get('android/'+modulefile+'.json')
 obs=mob['observed']; assert obs['topicKey']==topic and obs['sendDisabled']
 assert mob['readback']['sharedPermissions']==['shared:sharedAB:read']
 assert mob['readback']['sessionMarkerSha256']==baseline['readback']['sessionMarkerSha256']
 assert mob['secure'] and mob['standalone'] and mob['visible'] and mob['workerControlled'] and not mob['isPrivate']
 assert {j['id']:j['state'] for j in obs['executions']}=={req:'completed'}
 checkrows(obs['messages'])
 for m,body,role in zip(obs['messages'],bodies,roles):
  assert m['body']==body and m['role']==role and m['sha256']==sha(body)
 snapshot=get('android/'+('03-work.json' if mobilefile=='03-terminal' else '05-cold-work.json'))
 assert snapshot['status']==200 and snapshot['sharedId']==topic and snapshot['executionId']==req
 assert snapshot['request']==dict(id=req,requestId=work['request_id'],state='completed',userSeq=1,replySeq=2)
 assert snapshot['journalBody']['messageId']==ids[1] and snapshot['journalBody']['sha256']==sha(bodies[1])
 assert str(src['pid'])==str(mob['pid']) and src['bundle']==mob['bundle']
 module=src['bundle'].removeprefix('/mobile/')
 served=get('central/served-assets.json')[module]
 assert (src['loadedSha256']==src['servedSha256']==src['expectedBuildSha256']==served['sha256'] and src['loadedBytes']==served['bytes'])
 assert src['loadedSha256'] in (base/'build/SHA256SUMS').read_text()
 aps.append(mob['pid']);modules.append(served['sha256'])
assert all(len(set(p))==2 for p in (lps,wps,aps)) and len(set(modules))==1
assert sum(e['event']=='linux-submitted' for phase in ('initial','reopened') for e in get('linux/'+phase+'-lifecycle.json'))==1
print(json.dumps(dict(result='PASS',fixed=fixed,tree=tree,topic=topic,work=req,requestId=work['request_id'],state=work['state'],workCount=1,attempts=1,dispatched=1,providerCalls=1,journal=[{**row,'sha256':sha(row['body'])} for row in rows],processes=dict(linux=lps,windows=wps,firefox=aps),firefoxLoadedJS=modules[0]),ensure_ascii=False,indent=2))
