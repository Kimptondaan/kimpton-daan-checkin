# 大安金普頓員工刷卡系統

目前版本是可調校的預覽 MVP。預覽先使用 `src/lib/demoStore.ts` 的瀏覽器資料層，因此不需要先填入公司 IP 或 Supabase 金鑰即可操作畫面。

## 預覽帳號

- 員工：`DA001`、`DA002`、`DA003`，密碼都是 `00000000`
- 管理者：帳號 `ADMIN`，密碼 `00000000`

## 正式 Supabase 接線順序

1. 在 Supabase 建立專案。
2. 將 `.env.example` 複製成 `.env.local`，填入專案 URL 與 publishable key。
3. 執行 `supabase/migrations/001_initial_schema.sql`。
4. 建立 Supabase Auth 使用者，將使用者 UUID 對應到 `profiles.id`。
5. 部署 `supabase/functions/clock-in`，並設定 `SUPABASE_SERVICE_ROLE_KEY` 只存在於 Edge Function secrets。
6. 在管理者設定頁輸入公司固定公網 IP，改成正式 IP 模式。
7. 實際測試公司 Wi-Fi 可刷、手機行動網路被拒絕、員工不可修改自己的刷卡時間。

正式模式的 IP 判斷必須在伺服器端完成；不要讓瀏覽器傳入的 IP 直接成為可信資料。
