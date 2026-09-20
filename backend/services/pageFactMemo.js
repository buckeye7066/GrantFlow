/** Bounded immutable snapshots of profile-blind facts from identical page bytes.
 * No matching decision, account identity, credential or model usage is cached.
 */
export function createPageFactMemo({now=Date.now,maxEntries=256,maxBytes=16*1024*1024,ttlMs=3600000}={}) {
  const entries=new Map()
  let bytes=0
  const drop=key=>{const entry=entries.get(key);if(entry)bytes-=entry.bytes;entries.delete(key)}
  return {
    get(key) {
      const entry=entries.get(key)
      if(!entry)return null
      if(now()>=entry.until){drop(key);return null}
      entries.delete(key);entries.set(key,entry)
      return {data:JSON.parse(entry.json),status:entry.status}
    },
    set(key,data,status) {
      if(!['ok','empty'].includes(status)||!Array.isArray(data))return
      const json=JSON.stringify(data)
      const size=Buffer.byteLength(json)
      if(size>maxBytes)return
      drop(key)
      while(entries.size&&(entries.size>=maxEntries||bytes+size>maxBytes))drop(entries.keys().next().value)
      entries.set(key,{json,status,bytes:size,until:now()+(status==='empty'?Math.min(ttlMs,60000):ttlMs)})
      bytes+=size
    },
  }
}
export const pageFactMemo=createPageFactMemo()
