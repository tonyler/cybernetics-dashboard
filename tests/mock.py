# Mock cosmos.directory + chain REST so the real page code runs end-to-end offline.
import json, base64, time, datetime, re, hashlib
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
JUNO_VAL='junovaloper1yfx5x9cs3nvncprlw0kuw2cgs9qq38uqnwfhd8'
PEER=bech('cosmosvaloper', [7]*32); PEER2=bech('osmovaloper', [9]*32)
acct = lambda val, hrp: bech(hrp, data_of(val))
now=time.time()
iso=lambda s: datetime.datetime.utcfromtimestamp(now-s).strftime('%Y-%m-%dT%H:%M:%SZ')
fut=lambda s: datetime.datetime.utcfromtimestamp(now+s).strftime('%Y-%m-%dT%H:%M:%S.000000000Z')
D=86400

CG_PRICE={'cosmos':4.4,'osmosis':0.48,'juno-network':0.21,'dymension':1.25}
def chain(name, cid, sym, denom, dec, hrp, apr, unb, price, display):
    return {'repository':{}, 'chain':{'chain_name':name,'chain_id':cid,'pretty_name':name.title(),'bech32_prefix':hrp,'symbol':sym,'display':display,
      'denom':denom,'decimals':dec,'coingecko_id':{'cosmoshub':'cosmos','osmosis':'osmosis','juno':'juno-network','dymension':'dymension','nolus':'nolus'}[name],'params':{'calculated_apr':apr,'unbonding_time':unb},'prices':{'coingecko':{display:{'usd':price}}},
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
DEEP=[tx('H%d'%i, 2*D+i*7200, [ev('delegate',{'validator':COSMOS_VAL,'amount':'%d000000uatom'%(50+i%40)})],'new') for i in range(1200)]
COSMOS_TX["delegate.validator='%s'"%COSMOS_VAL]=COSMOS_TX["delegate.validator='%s'"%COSMOS_VAL]+DEEP
TXS={'cosmoshub':COSMOS_TX,'osmosis':OSMO_TX,'juno':JUNO_TX,'dymension':{}}
LEGACY={'osmosis'}
calls=[]
search_calls=[]
HEIGHT0=33947379
def consensus_key(valoper): return base64.b64encode(hashlib.sha256(valoper.encode()).digest()).decode()   # stable fake ed25519 key
def hex_addr(valoper): return hashlib.sha256(base64.b64decode(consensus_key(valoper))).hexdigest()[:40].upper()

def handle(route):
    u=route.request.url; p=urlparse(u); qs=parse_qs(p.query); path=p.path
    def ok(body, status=200): return route.fulfill(status=status, content_type='application/json', headers={'access-control-allow-origin':'*'}, body=json.dumps(body))
    calls.append(u)
    if p.hostname=='public-osmosis-api.numia.xyz':
        today=datetime.datetime.utcfromtimestamp(time.time()-D).strftime('%Y-%m-%d')
        return ok([{'symbol':'OSMO','labels':today+' 00:00:00','apr':2.0},
                   {'symbol':'total','labels':today+' 00:00:00','apr':5.2}])
    if p.hostname=='app.nolus.io' and path=='/api/governance/apr':
        return ok({'apr':0.045,'annualInflation':0})
    if p.hostname=='chains.cosmos.directory':
        n=path.strip('/');  return ok(CHAINS[n]) if n in CHAINS else ok({'error':'x'},500)
    if p.hostname=='validators.cosmos.directory':
        n=path.split('/')[-1]
        if n=='juno': return ok({'name':'juno','validators':[{'moniker':'Other','identity':'X','operator_address':bech('junovaloper',[1]*32)},{'moniker':'The_Cybernetics','identity':'AB3DA9B8891D4F85','operator_address':JUNO_VAL}]})
        if n=='nolus': return ok({'name':'nolus','validators':[{'moniker':'Someone','identity':'Y','operator_address':'nolusvaloper1zz'}]})
        return ok({'validators':[]})
    if p.hostname=='api.coingecko.com':
        if path.endswith('/simple/price'):
            return ok({cid:{'usd':CG_PRICE[cid]} for cid in qs['ids'][0].split(',') if cid in CG_PRICE})
        m=re.match(r'/api/v3/coins/([\w-]+)/market_chart', path)
        if m and m.group(1) in CG_PRICE:
            d0=int(now//D)*D
            return ok({'prices':[[ (d0-k*D)*1000, CG_PRICE[m.group(1)]*(1+0.002*k) ] for k in range(int(qs['days'][0]),-1,-1)]})
        return ok({'error':'unknown'},404)
    if p.hostname=='rpc.cosmos.directory':
        n=path.split('/')[1]
        if path.endswith('/commit'):
            top=HEIGHT0+int(time.time()-now)//6
            h=int(qs['height'][0]) if 'height' in qs else top
            ours=[a for a in VALS.get(n,{}) if a.startswith(('cosmosvaloper','osmovaloper','junovaloper','dymvaloper','nolus','chihuahua'))][0]
            me=hex_addr(ours)
            sigs=[{'block_id_flag':2,'validator_address':'AB'*20,'signature':'x'}]
            if h % 17 != 0: sigs.append({'block_id_flag':2,'validator_address':me,'signature':'x'})
            else: sigs.append({'block_id_flag':1,'validator_address':'','signature':None})
            return ok({'jsonrpc':'2.0','id':-1,'result':{'signed_header':{'header':{'height':str(h),'time':iso(0)},'commit':{'height':str(h),'signatures':sigs}},'canonical':True}})
    if p.hostname=='rest.cosmos.directory':
        n=path.split('/')[1]; rest='/'+'/'.join(path.split('/')[2:])
        m=re.match(r'/cosmos/staking/v1beta1/validators/([^/]+)$', rest)
        if m:
            v=VALS.get(n,{}).get(m.group(1))
            if not v: return ok({'code':5,'message':'not found'},404)
            return ok({'validator':{'operator_address':m.group(1),'jailed':False,'status':'BOND_STATUS_BONDED','tokens':v[1],'description':{'moniker':v[0]},
                'consensus_pubkey':{'@type':'/cosmos.crypto.ed25519.PubKey','key':consensus_key(m.group(1))},'commission':{'commission_rates':{'rate':v[2]}}}})
        m=re.match(r'/cosmos/staking/v1beta1/validators/([^/]+)/delegations$', rest)
        if m: return ok({'delegation_responses':[{'delegation':{'delegator_address':'probe-small'},'balance':{'amount':'1000000'}},
                                                 {'delegation':{'delegator_address':'probe-big','validator_address':m.group(1)},'balance':{'amount':'500000000000'}}]})
        m=re.match(r'/cosmos/staking/v1beta1/validators/([^/]+)/delegations/([^/]+)$', rest)
        if m: return ok({'delegation_response':{'balance':{'amount':'500000000000'}}})
        m=re.match(r'/cosmos/distribution/v1beta1/delegators/([^/]+)/rewards/([^/]+)$', rest)
        if m:   # 15%/yr net, accruing in real time since the mock started
            denom=[c['chain']['denom'] for c in CHAINS.values() if m.group(2).startswith(c['chain']['bech32_prefix'])][0]
            return ok({'rewards':[{'denom':denom,'amount':'%.18f'%(500000000000*0.15*(time.time()-now)/(365*D))}]})
        if rest=='/cosmos/staking/v1beta1/validators':
            return ok({'validators':[{'operator_address':a,'description':{'moniker':v[0]}} for a,v in VALS.get(n,{}).items()],'pagination':{'next_key':None}})
        if rest.startswith('/cosmos/slashing/v1beta1/signing_infos/'):
            return ok({'val_signing_info':{'address':rest.split('/')[-1],'missed_blocks_counter':'7'}})
        if rest=='/cosmos/slashing/v1beta1/params':
            return ok({'params':{'signed_blocks_window':'10000'}})
        if rest=='/cosmos/tx/v1beta1/txs' and route.request.method=='GET':
            if 'query' in qs:
                if n in LEGACY: return ok({'code':3,'message':'must declare at least one event'},400)
                q=qs['query'][0]
            else:
                if n not in LEGACY: return ok({'code':3,'message':'query cannot be empty'},400)
                q=qs['events'][0]
            allt=TXS.get(n,{}).get(q,[])
            if 'query' in qs: page=int(qs.get('page',['1'])[0]); lim=int(qs.get('limit',['100'])[0]); off=(page-1)*lim
            else: off=int(qs.get('pagination.offset',['0'])[0]); lim=int(qs.get('pagination.limit',['100'])[0])
            search_calls.append((n, q.split('=')[0], off//lim+1))
            return ok({'txs':[],'tx_responses':allt[off:off+lim],'total':str(len(allt))})
        if rest=='/cosmos/base/tendermint/v1beta1/blocks/latest':
            return ok({'sdk_block':{'header':{'height':str(23481902+int(time.time()-now)//6)}}})
        # wallet endpoints
        if rest.startswith('/cosmos/bank/v1beta1/balances/'): return ok({'balance':{'denom':'uatom','amount':'999000000'}})
        if rest.startswith('/cosmos/auth/v1beta1/accounts/'): return ok({'account':{'@type':'/cosmos.vesting.v1beta1.ContinuousVestingAccount','base_vesting_account':{'base_account':{'address':'x','account_number':'4242','sequence':'17'}}}})
        if rest=='/cosmos/tx/v1beta1/simulate': return ok({'gas_info':{'gas_used':'180000','gas_wanted':'0'}})
        if rest=='/cosmos/tx/v1beta1/txs': return ok({'tx_response':{'txhash':'ABCDEF0123456789','code':0}})
    return route.continue_()
