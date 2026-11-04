import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const authorization = req.headers.get('Authorization')
    if (!authorization) return json({ error: '未登入' }, 401)

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    })
    const { data: { user }, error: userError } = await userClient.auth.getUser()
    if (userError || !user) return json({ error: '登入資訊無效' }, 401)

    const { attendanceType } = await req.json()
    if (!['check_in', 'check_out'].includes(attendanceType)) return json({ error: '打卡類型錯誤' }, 400)

    // 正式環境請依部署平台的可信任 proxy 合約讀取來源 IP；不要相信瀏覽器傳來的 clientIp。
    const forwardedFor = req.headers.get('x-forwarded-for')
    const clientIp = req.headers.get('x-real-ip') || forwardedFor?.split(',').at(-1)?.trim()
    if (!clientIp) return json({ error: '無法取得來源 IP' }, 403)

    const adminClient = createClient(supabaseUrl, serviceRoleKey)
    const { data: matchedNetwork, error: networkError } = await adminClient.rpc('find_network_for_ip', { input_ip: clientIp })
    if (networkError) throw networkError
    if (!matchedNetwork) return json({ error: '目前不在公司允許的網路範圍內' }, 403)

    const { data: record, error: insertError } = await adminClient
      .from('attendance_records')
      .insert({
        employee_id: user.id,
        attendance_type: attendanceType,
        client_ip: clientIp,
        matched_network_id: matchedNetwork.id,
        user_agent: req.headers.get('user-agent'),
        status: 'accepted',
      })
      .select('id, attendance_type, punched_at')
      .single()

    if (insertError?.code === '23505') return json({ error: '今天這個打卡類型已經完成' }, 409)
    if (insertError) throw insertError
    return json({ success: true, record })
  } catch (error) {
    console.error(error)
    return json({ error: '系統錯誤，請稍後再試' }, 500)
  }
})

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
