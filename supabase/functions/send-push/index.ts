import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'
import webpush from 'https://esm.sh/web-push@3.6.7'

const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY')
const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')
const vapidSubject = Deno.env.get('VAPID_EMAIL') || 'mailto:chat@example.com'

if (!vapidPublicKey || !vapidPrivateKey) {
  console.error('FATAL: Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY env vars')
}

webpush.setVapidDetails(vapidSubject, vapidPublicKey!, vapidPrivateKey!)

serve(async (req) => {
  try {
    const body = await req.json()
    const { type, table, record } = body

    if (type !== 'INSERT' || table !== 'messages') {
      return new Response('ignored', { status: 200 })
    }

    if (!vapidPublicKey || !vapidPrivateKey) {
      console.error('VAPID keys not configured')
      return new Response('VAPID keys not configured', { status: 500 })
    }

    const msg = record
    const recipientName = msg.sender === 'Arnav' ? 'Ojas' : 'Arnav'

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: sub } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('name', recipientName)
      .maybeSingle()

    if (!sub?.subscription) {
      return new Response('no subscription for ' + recipientName, { status: 200 })
    }

    const content = msg.msg_type === 'image' ? '📷 Image' : (msg.content || '')
    const payload = JSON.stringify({
      title: msg.sender,
      body: content.substring(0, 200),
      icon: 'icon.svg',
      badge: 'icon.svg',
      tag: 'simpchat-message',
      data: { url: `?name=${recipientName}` },
    })

    try {
      await webpush.sendNotification(sub.subscription, payload)
    } catch (pushErr: unknown) {
      const status = (pushErr as { statusCode?: number })?.statusCode
      console.error('Push send error:', status, (pushErr as Error)?.message)
      if (status === 410 || status === 404) {
        await supabase.from('push_subscriptions').delete().eq('name', recipientName)
      }
    }

    return new Response('sent', { status: 200 })
  } catch (err) {
    console.error('Push handler error:', (err as Error)?.message)
    return new Response('error', { status: 500 })
  }
})
