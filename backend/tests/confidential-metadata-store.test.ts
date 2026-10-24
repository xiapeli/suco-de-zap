import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createConfidentialMetadataStore } from '../src/lib/confidential-metadata-store.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const jwt = `header.${Buffer.from(JSON.stringify({
  sub: OWNER, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64url')}.signature`;

function fakeRemote() {
  const rows = new Map<string, {
    object_id: string; key_epoch: number; nonce_hex: string; ciphertext_hex: string; revision: string;
  }>();
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const name = String(input).split('/').at(-1);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (name === 'suco_meta_list') {
      const after = body.p_after as string | null;
      const list = [...rows.values()].sort((a,b)=>a.object_id.localeCompare(b.object_id))
        .filter((row)=>!after||row.object_id>after).slice(0,Number(body.p_limit));
      return new Response(JSON.stringify(list));
    }
    if (name === 'suco_meta_put') {
      const id = body.p_object_id as string;
      const old = rows.get(id);
      if ((old?.revision ?? '0') !== body.p_expected_revision)
        return new Response(JSON.stringify({code:'40001'}),{status:409});
      const revision = String(Number(old?.revision ?? '0')+1);
      rows.set(id,{object_id:id,key_epoch:Number(body.p_key_epoch),
        nonce_hex:String(body.p_nonce_hex),ciphertext_hex:String(body.p_ciphertext_hex),revision});
      return new Response(JSON.stringify(revision));
    }
    return new Response('{}',{status:404});
  };
  return { rows, bodies, fetcher };
}

function options(key: Uint8Array, fetcher: typeof fetch) {
  return { url:'https://synthetic.supabase.co',publishableKey:'sb_publishable_synthetic',
    ownerId:OWNER,tenantId:'owner-test',keyEpoch:1,key,userJwt:async()=>jwt,fetcher };
}

test('group names, contact names and LID mapping survive restart only as ciphertext', async () => {
  const key=randomBytes(32), remote=fakeRemote();
  const first=createConfidentialMetadataStore(options(key,remote.fetcher));
  await first.load();
  await first.putChat('synthetic@g.us','Private Group',true);
  await first.putChat('synthetic@g.us',null,true);
  await first.putContact('123@s.whatsapp.net',{name:'Private Contact',notify:null});
  await first.putLidMap('456@lid','123@s.whatsapp.net');
  assert.equal(remote.rows.size,3);
  assert.deepEqual(await first.chatList(),[{jid:'synthetic@g.us',name:'Private Group',is_group:true,tracked:false,archived:false,tracked_since:null}]);
  assert.equal(await first.contactName('123@s.whatsapp.net'),'Private Contact');
  assert.equal(await first.resolveLid('456@lid'),'123@s.whatsapp.net');
  const sent=JSON.stringify(remote.bodies);
  assert.equal(sent.includes('Private Group'),false);
  assert.equal(sent.includes('Private Contact'),false);
  assert.equal(sent.includes('synthetic@g.us'),false);
  assert.equal(sent.includes('123@s.whatsapp.net'),false);
  first.close();

  const restored=createConfidentialMetadataStore(options(key,remote.fetcher));
  assert.deepEqual(await restored.chatList(),[{jid:'synthetic@g.us',name:'Private Group',is_group:true,tracked:false,archived:false,tracked_since:null}]);
  assert.deepEqual(await restored.contactList(),[{jid:'123@s.whatsapp.net',name:'Private Contact',notify:null}]);
  assert.deepEqual(await restored.lidMapList(),[{lid:'456@lid',pn:'123@s.whatsapp.net'}]);
  restored.close();
});

test('wrong key, tampered ciphertext and wrong tenant fail before metadata is used', async () => {
  const key=randomBytes(32), remote=fakeRemote();
  const first=createConfidentialMetadataStore(options(key,remote.fetcher));
  await first.putChat('synthetic@g.us','Private Group',true);
  first.close();
  const wrongKey=createConfidentialMetadataStore(options(randomBytes(32),remote.fetcher));
  await assert.rejects(wrongKey.chatList(),{code:'INGESTION_SPOOL_UNREADABLE'});
  wrongKey.close();
  const wrongTenant=createConfidentialMetadataStore({...options(key,remote.fetcher),tenantId:'other-tenant'});
  await assert.rejects(wrongTenant.chatList(),{code:'INGESTION_SPOOL_UNREADABLE'});
  wrongTenant.close();
  const row=[...remote.rows.values()][0];
  row.ciphertext_hex=row.ciphertext_hex.slice(0,-2)+'00';
  const tampered=createConfidentialMetadataStore(options(key,remote.fetcher));
  await assert.rejects(tampered.chatList(),{code:'INGESTION_SPOOL_UNREADABLE'});
  tampered.close();
});

test('stale writer reloads ciphertext and retries CAS without losing newer group name', async () => {
  const key=randomBytes(32), remote=fakeRemote();
  const first=createConfidentialMetadataStore(options(key,remote.fetcher));
  const second=createConfidentialMetadataStore(options(key,remote.fetcher));
  await first.load();await second.load();
  await first.putChat('synthetic@g.us','First',true);
  await second.putChat('synthetic@g.us','Second',true);
  assert.deepEqual(await second.chatList(),[{jid:'synthetic@g.us',name:'Second',is_group:true,tracked:false,archived:false,tracked_since:null}]);
  first.close();second.close();
});

test('tracking survives WhatsApp metadata refresh and restart without plaintext in Supabase', async () => {
  const key=randomBytes(32), remote=fakeRemote();
  const first=createConfidentialMetadataStore(options(key,remote.fetcher));
  await first.putChat('synthetic@g.us','Private Group',true);
  assert.equal((await first.setChatTracking('synthetic@g.us',true)).tracked,true);
  await first.putChat('synthetic@g.us','Renamed Group',true);
  assert.equal((await first.chatList())[0].tracked,true);
  assert.equal(JSON.stringify(remote.bodies).includes('synthetic@g.us'),false);
  first.close();
  const restored=createConfidentialMetadataStore(options(key,remote.fetcher));
  const saved=(await restored.chatList())[0];
  assert.equal(saved.name,'Renamed Group');
  assert.equal(saved.tracked,true);
  assert.ok(Number.isFinite(Date.parse(saved.tracked_since!)));
  restored.close();
});
