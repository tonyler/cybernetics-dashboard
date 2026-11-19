# Mock cosmos.directory + chain REST so the real page code runs end-to-end offline.
import json, base64, time, datetime, re
from urllib.parse import urlparse, parse_qs, unquote

CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
def polymod(v):
    G=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3]; c=1
    for x in v:
        t=c>>25; c=((c&0x1ffffff)<<5)^x
        for i in range(5):
            if (t>>i)&1: c^=G[i]
    return c
def bech(hrp, data):
    e=[ord(x)>>5 for x in hrp]+[0]+[ord(x)&31 for x in hrp]
    m=polymod(e+data+[0]*6)^1
    return hrp+'1'+''.join(CH[d] for d in data+[(m>>5*(5-i))&31 for i in range(6)])
def data_of(addr): return [CH.index(c) for c in addr[addr.rfind('1')+1:-6]]

COSMOS_VAL='cosmosvaloper18m9wncg0w74vusm4xu0mk6ha2lpdrqq7c9cjq3'
OSMO_VAL='osmovaloper10w06wvmdd4xn7hr76gzrv570f7q5uweem5jcd7'
DYM_VAL='dymvaloper1x4dhky07zxuaew2ru7tgvtd68vjk3x56w5p5lh'
JUNO_VAL=bech('junovaloper', data_of(COSMOS_VAL)[::-1])
PEER=bech('cosmosvaloper', [7]*32); PEER2=bech('osmovaloper', [9]*32)
acct = lambda val, hrp: bech(hrp, data_of(val))
now=time.time()
iso=lambda s: datetime.datetime.utcfromtimestamp(now-s).strftime('%Y-%m-%dT%H:%M:%SZ')
fut=lambda s: datetime.datetime.utcfromtimestamp(now+s).strftime('%Y-%m-%dT%H:%M:%S.000000000Z')
D=86400

def chain(name, cid, sym, denom, dec, hrp, apr, unb, price, display):
    return {'repository':{}, 'chain':{'chain_name':name,'chain_id':cid,'pretty_name':name.title(),'bech32_prefix':hrp,'symbol':sym,'display':display,
      'denom':denom,'decimals':dec,'params':{'calculated_apr':apr,'unbonding_time':unb},'prices':{'coingecko':{display:{'usd':price}}},
      'fees':{'fee_tokens':[{'denom':denom,'low_gas_price':0.005,'average_gas_price':0.025}]}}}
CHAINS={
 'cosmoshub':chain('cosmoshub','cosmoshub-4','ATOM','uatom',6,'cosmos',0.1973,1814400,4.5,'atom'),
 'osmosis':chain('osmosis','osmosis-1','OSMO','uosmo',6,'osmo',0.06,1209600,0.5,'osmo'),
 'juno':chain('juno','juno-1','JUNO','ujuno',6,'juno',0.12,2419200,0.2,'juno'),
 'nolus':chain('nolus','pirin-1','NLS','unls',6,'nolus',0.18,1814400,0.01,'nls'),
 'dymension':chain('dymension','dymension_1100-1','DYM','adym',18,'dym',0.05,1814400,1.2,'dym'),
}
VALS={
 'cosmoshub':{COSMOS_VAL:('The_Cybernetics','2160000000000','0.050000000000000000'),PEER:('Northstake','1','0.1')},
 'osmosis':{OSMO_VAL:('The_Cybernetics','2680000000000','0.050000000000000000'),PEER2:('Helix Nodes','1','0.1')},
 'juno':{JUNO_VAL:('The_Cybernetics','1400000000000','0.050000000000000000')},
 'dymension':{DYM_VAL:('The_Cybernetics','633000000000000000000000','0.050000000000000000')},
}

def ev(t, attrs, b64=False):
    enc=(lambda x: base64.b64encode(x.encode()).decode()) if b64 else (lambda x:x)
    return {'type':t,'attributes':[{'key':enc(k),'value':enc(v),'index':True} for k,v in attrs.items()]}
def tx(h, ago, events, style):
    r={'txhash':h,'height':'1','code':0,'timestamp':iso(ago)}
    if style=='logs': r.update(logs=[{'msg_index':0,'events':events}], events=[])
    else: r.update(logs=[], events=events)
    return r

# cosmoshub: SDK 0.50 (query=, plain tx.events)
CA=acct(COSMOS_VAL,'cosmos')
COSMOS_TX={
 "delegate.validator='%s'"%COSMOS_VAL:[tx('C1',3600,[ev('message',{'action':'x'}),ev('delegate',{'validator':COSMOS_VAL,'amount':'324000000uatom','delegator':'cosmos1x'})],'new'),
                                      tx('C2',5*D,[ev('delegate',{'validator':COSMOS_VAL,'amount':'1000000000uatom'}),ev('delegate',{'validator':PEER,'amount':'5uatom'})],'new')],
 "unbond.validator='%s'"%COSMOS_VAL:[tx('C3',7200,[ev('unbond',{'validator':COSMOS_VAL,'amount':'79000000uatom','completion_time':fut(20*D)})],'new'),
                                    tx('C4',30*D,[ev('unbond',{'validator':COSMOS_VAL,'amount':'500000000uatom','completion_time':iso(9*D)})],'new')],
 "redelegate.destination_validator='%s'"%COSMOS_VAL:[tx('C5',2*D,[ev('redelegate',{'source_validator':PEER,'destination_validator':COSMOS_VAL,'amount':'1150000000uatom'})],'new')],
 "redelegate.source_validator='%s'"%COSMOS_VAL:[],
 "message.sender='%s'"%CA:[tx('C6',4*3600,[ev('proposal_vote',{'option':'{"option":1,"weight":"1.000000000000000000"}','proposal_id':'1021','voter':CA})],'new')],
}
# osmosis: legacy (events=, logs)
OA=acct(OSMO_VAL,'osmo')
OSMO_TX={
 "delegate.validator='%s'"%OSMO_VAL:[tx('O1',3*3600,[ev('delegate',{'validator':OSMO_VAL,'amount':'872000000'})],'logs')],
 "unbond.validator='%s'"%OSMO_VAL:[],
 "redelegate.destination_validator='%s'"%OSMO_VAL:[],
 "redelegate.source_validator='%s'"%OSMO_VAL:[tx('O2',8*3600,[ev('redelegate',{'source_validator':OSMO_VAL,'destination_validator':PEER2,'amount':'310000000uosmo'})],'logs')],
 "message.sender='%s'"%OA:[tx('O3',26*3600,[ev('proposal_vote',{'option':'option:VOTE_OPTION_ABSTAIN weight:"1.000000000000000000"','proposal_id':'932'})],'logs')],
}
# juno: query=, base64 tx.events (no logs)
JA=acct(JUNO_VAL,'juno')
JUNO_TX={
 "delegate.validator='%s'"%JUNO_VAL:[tx('J1',6*3600,[ev('delegate',{'validator':JUNO_VAL,'amount':'4600000000ujuno'},True)],'new')],
 "message.sender='%s'"%JA:[tx('J2',10*3600,[ev('proposal_vote',{'option':'VOTE_OPTION_NO_WITH_VETO','proposal_id':'374','voter':JA},True)],'new')],
}
TXS={'cosmoshub':COSMOS_TX,'osmosis':OSMO_TX,'juno':JUNO_TX,'dymension':{}}
LEGACY={'osmosis'}
calls=[]

def handle(route):
    u=route.request.url; p=urlparse(u); qs=parse_qs(p.query); path=p.path
    def ok(body, status=200): return route.fulfill(status=status, content_type='application/json', headers={'access-control-allow-origin':'*'}, body=json.dumps(body))
    calls.append(u)
    if p.hostname=='chains.cosmos.directory':
        n=path.strip('/');  return ok(CHAINS[n]) if n in CHAINS else ok({'error':'x'},500)
    if p.hostname=='validators.cosmos.directory':
        n=path.split('/')[-1]
        if n=='juno': return ok({'name':'juno','validators':[{'moniker':'Other','identity':'X','operator_address':bech('junovaloper',[1]*32)},{'moniker':'The_Cybernetics','identity':'AB3DA9B8891D4F85','operator_address':JUNO_VAL}]})
        if n=='nolus': return ok({'name':'nolus','validators':[{'moniker':'Someone','identity':'Y','operator_address':'nolusvaloper1zz'}]})
        return ok({'validators':[]})
    if p.hostname=='rest.cosmos.directory':
        n=path.split('/')[1]; rest='/'+'/'.join(path.split('/')[2:])
        m=re.match(r'/cosmos/staking/v1beta1/validators/(.+)', rest)
        if m:
            v=VALS.get(n,{}).get(m.group(1))
            if not v: return ok({'code':5,'message':'not found'},404)
            return ok({'validator':{'operator_address':m.group(1),'jailed':False,'tokens':v[1],'description':{'moniker':v[0]},'commission':{'commission_rates':{'rate':v[2]}}}})
        if rest=='/cosmos/tx/v1beta1/txs' and route.request.method=='GET':
            if 'query' in qs:
                if n in LEGACY: return ok({'code':3,'message':'must declare at least one event'},400)
                q=qs['query'][0]
            else:
                if n not in LEGACY: return ok({'code':3,'message':'query cannot be empty'},400)
                q=qs['events'][0]
            return ok({'txs':[],'tx_responses':TXS.get(n,{}).get(q,[]),'total':'0'})
        if rest=='/cosmos/base/tendermint/v1beta1/blocks/latest':
            return ok({'sdk_block':{'header':{'height':str(23481902+int(time.time()-now)//6)}}})
        # wallet endpoints
        if rest.startswith('/cosmos/bank/v1beta1/balances/'): return ok({'balance':{'denom':'uatom','amount':'999000000'}})
        if rest.startswith('/cosmos/auth/v1beta1/accounts/'): return ok({'account':{'@type':'/cosmos.vesting.v1beta1.ContinuousVestingAccount','base_vesting_account':{'base_account':{'address':'x','account_number':'4242','sequence':'17'}}}})
        if rest=='/cosmos/tx/v1beta1/simulate': return ok({'gas_info':{'gas_used':'180000','gas_wanted':'0'}})
        if rest=='/cosmos/tx/v1beta1/txs': return ok({'tx_response':{'txhash':'ABCDEF0123456789','code':0}})
    return route.continue_()
