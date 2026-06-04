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

serve(async (req) => {
  try {
    const body = await req.json()
    const { type, table, record } = body
    if (type !== 'INSERT' || table !== 'messages') return new Response('ignored', { status: 200 })

    const pubKey = Deno.env.get('VAPID_PUBLIC_KEY')
    const privKey = Deno.env.get('VAPID_PRIVATE_KEY')
    const subject = Deno.env.get('VAPID_EMAIL') || 'mailto:chat@example.com'

    if (!pubKey || !privKey) {
      console.error('Missing VAPID keys')
      return new Response('missing keys', { status: 500 })
    }

    const recipient = record.sender === 'Arnav' ? 'Ojas' : 'Arnav'

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: sub } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('name', recipient)
      .maybeSingle()

    if (!sub?.subscription) return new Response('no subscription', { status: 200 })

    const jwt = await vapidSign(privKey, pubKey, subject, new URL(sub.subscription.endpoint).origin)
    const pubB64 = b64url(fromB64url(pubKey).buffer)

    const resp = await fetch(sub.subscription.endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400',
        'Content-Length': '0',
        Authorization: `WebPush ${jwt}`,
        'Crypto-Key': `p256ecdsa=${pubB64}`,
      },
    })

    if (!resp.ok) {
      const text = await resp.text()
      console.error('Push fail', resp.status, text)
      if (resp.status === 410 || resp.status === 404) {
        await supabase.from('push_subscriptions').delete().eq('name', recipient)
      }
    }

    return new Response('sent', { status: 200 })
  } catch (err) {
    console.error('Push error:', (err as Error).message)
    return new Response('error', { status: 500 })
  }
})
