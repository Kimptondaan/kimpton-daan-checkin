import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

async function timedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  init?.signal?.addEventListener('abort', abort, { once: true })
  if (init?.signal?.aborted) controller.abort()
  const timer = window.setTimeout(abort, 20000)
  try { return await fetch(input, { ...init, signal: controller.signal }) }
  finally { window.clearTimeout(timer); init?.signal?.removeEventListener('abort', abort) }
}

export const supabase: SupabaseClient | null = url && anonKey
  ? createClient(url, anonKey, { global: { fetch: timedFetch } })
  : null

export const supabaseReady = Boolean(supabase)
