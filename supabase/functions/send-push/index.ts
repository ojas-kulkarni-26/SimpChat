import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function fromB64url(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4)
  return Uint8Array.from(atob(s), c => c.charCodeAt(0))
}

async function vapidSign(privB64: string, pubB64: string, sub: string, aud: string): Promise<string> {
  const pub = fromB64url(pubB64)
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: b64url(fromB64url(privB64).buffer),
    x: b64url(pub.slice(1, 33).buffer),
    y: b64url(pub.slice(33, 65).buffer),
  }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])

  const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'ES256', typ: 'JWT' })))
  const p = b64url(new TextEncoder().encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 86400, sub })))
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(h + '.' + p))

  return h + '.' + p + '.' + b64url(sig)
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data))
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  let t = new Uint8Array(0)
  const out = new Uint8Array(len)
  for (let i = 1; out.length < len; i++) {
    t = await hmacSha256(prk, new Uint8Array([...t, ...info, i]))
    out.set(t, (i - 1) * 32)
  }
  return out.slice(0, len)
}

async function encryptWebPushPayload(
  plaintext: string,
  receiverPub: Uint8Array,
  authSecret: Uint8Array
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const ephem = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const ephemPub = new Uint8Array(await crypto.subtle.exportKey('raw', ephem.publicKey!))
  const rcvr = await crypto.subtle.importKey('raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: rcvr }, ephem.privateKey, 256))

  const info = new Uint8Array([...new TextEncoder().encode('WebPush: info'), 0x00, ...receiverPub, ...ephemPub])
  const prk = await hmacSha256(authSecret, shared)
  const cek = await hkdfExpand(prk, new Uint8Array([...info, 0x01]), 16)
  const nonce = await hkdfExpand(prk, new Uint8Array([...info, 0x02]), 12)

  const plainBytes = new TextEncoder().encode(plaintext)
  const encKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, encKey, plainBytes
  ))

  const body = new Uint8Array(16 + 4 + 65 + ciphertext.length)
  body.set(salt, 0)
  new DataView(body.buffer).setUint32(16, ciphertext.length, false)
  body.set(ephemPub, 20)
  body.set(ciphertext, 85)
  return body
}

serve(async (req) => {
  try {
    const body = await req.json()
    const { type, table, record } = body
    if (type !== 'INSERT' || table !== 'messages') return new Response('ignored', { status: 200 })
    if (!record || typeof record.sender !== 'string') {
      console.error('Invalid webhook payload')
      return new Response('invalid payload', { status: 400 })
    }

    const pubKey = Deno.env.get('VAPID_PUBLIC_KEY')
    const privKey = Deno.env.get('VAPID_PRIVATE_KEY')
    const subject = Deno.env.get('VAPID_EMAIL') || 'mailto:chat@example.com'

    if (!pubKey || !privKey) {
      console.error('Missing VAPID keys')
      return new Response('missing keys', { status: 500 })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('*')
      .neq('name', record.sender)

    if (!subs || subs.length === 0) return new Response('no subscriptions', { status: 200 })

    const pubB64 = b64url(fromB64url(pubKey).buffer)
    const endpointOrigin = subs.length > 0 ? new URL(subs[0].subscription.endpoint).origin : ''
    const jwt = await vapidSign(privKey, pubKey, subject, endpointOrigin)

    const payload = JSON.stringify({
      sender: record.sender,
      content: (record.content || '').substring(0, 200),
      msg_type: record.msg_type || 'text',
    })

    const results = await Promise.allSettled(subs.map(async (sub) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)

      try {
        const keys = sub.subscription.keys
        let body: Uint8Array | null = null
        let contentLength = '0'
        let extraHeaders: Record<string, string> = {}

        if (keys && keys.p256dh && keys.auth) {
          try {
            body = await encryptWebPushPayload(payload, fromB64url(keys.p256dh), fromB64url(keys.auth))
            contentLength = String(body.length)
            extraHeaders['Content-Encoding'] = 'aes128gcm'
            extraHeaders['Content-Type'] = 'application/octet-stream'
          } catch (e) {
            console.error('Encryption failed for', sub.name, 'falling back to empty payload')
          }
        }

        const resp = await fetch(sub.subscription.endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            TTL: '86400',
            'Content-Length': contentLength,
            Authorization: `WebPush ${jwt}`,
            'Crypto-Key': `p256ecdsa=${pubB64}`,
            ...extraHeaders,
          },
          body: body || undefined,
        })

        if (!resp.ok) {
          const text = await resp.text()
          console.error('Push fail', resp.status, text)
          if (resp.status === 410 || resp.status === 404) {
            await supabase.from('push_subscriptions').delete().eq('name', sub.name)
          }
        }
      } finally {
        clearTimeout(timeout)
      }
    }))

    const failed = results.filter(r => r.status === 'rejected').length
    if (failed > 0) console.error(failed, 'push(es) failed')

    return new Response('sent to ' + subs.length + ' recipient(s)', { status: 200 })
  } catch (err) {
    console.error('Push error:', (err as Error).message)
    return new Response('error', { status: 500 })
  }
})
