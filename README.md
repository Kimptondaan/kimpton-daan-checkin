# 大安金普頓員工刷卡系統

## 目前狀態（2026-11-12）

前端登入已使用 Supabase Auth；雲端登入後，員工與出勤資料由 Netlify 後端讀取 Supabase。登入欄位初始空白，失敗直接顯示原因，登出只清除本裝置的登入。前端不以 localStorage 的員工密碼代替雲端驗證。

這仍是資料搬移中的版本，尚未完成全系統正式上線。原桌面建立的部門、員工、管理者與刷卡紀錄，需要透過原桌面瀏覽器匯出的 JSON 備份搬移。目前管理新增／異動已暫停，避免再產生只存在單一裝置的資料；本機 ADMIN 僅保留原資料查看及備份入口，不具有雲端管理權限。

雲端登入帳號格式為 `{員工編號小寫}@checkin.kimptondaan.local`，profiles.id 必須等於 Auth user UUID。這是系統內部帳號映射，不是用來收信的電子郵件。

## 程式結構

- `src/App.tsx`：登入、個人刷卡、管理介面、篩選與 TXT 下載。
- `src/lib/supabase.ts`：公開 Supabase client 與手機相容的逾時控制。
- `src/lib/cloudStore.ts`：帶入 Auth access token 呼叫相對路徑 `/api/attendance`。
- `netlify/functions/attendance-api.mjs`：驗證 token、檢查啟用狀態與角色、範圍限定的資料讀取；刷卡時間取伺服器時間，來源 IP 只信任 Netlify context.ip。
- `src/lib/demoStore.ts`：保留舊桌面備份資料；雲端快照不會覆寫它。
- `scripts/migrate_preview_backup.mjs`：具備預檢、dry-run 與穩定來源紀錄 UUID 的一次性搬移腳本，不重設既有雲端密碼。
- `supabase/migrations`：初始資料結構及禁止瀏覽器直接寫入的權限補強。

## Netlify 部署

連結 GitHub main，建置命令 `pnpm run build`，輸出目錄 `dist`，函式目錄 `netlify/functions`。設定下列環境變數後須重新部署，不能只儲存變數而不重新建置。

- `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`：前端公開連線設定。Anon／publishable key 本來就會出現在前端程式，授權依靠 RLS 與後端驗證，不靠隱藏此金鑰。
- `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`：後端程式讀取的連線設定。伺服器金鑰名稱絕不可加上 `VITE_`，不可寫進原始碼、Git、TXT 或前端 bundle。

目前 Netlify 方案使用 All scopes；Specific scopes 需升級。環境變數只開放 Netlify 帳號與團隊獲授權的管理人員存取。伺服器程式只在執行期讀取 service key，交付前必須檢查前端 bundle 沒有包含該值。

## 資料搬移與正式使用前的必要步驟

1. 在最初建立員工／部門的同一個桌面瀏覽器、同一個網站來源，用原 ADMIN 密碼進入「系統設定」，下載 JSON 備份。不同裝置／不同網址的 localStorage 不是同一份資料；搬移前不要清除瀏覽器儲存。備份含舊版密碼，應視為機密，不可提交 Git 或公開。
2. 在 Supabase SQL Editor 執行 `001_initial_schema.sql`（已建立時不必重做），再執行 `002_server_only_writes.sql`。後者不刪資料，用來禁止瀏覽器自行偽造時間、修改角色或啟用狀態；已於 2026-11-12 執行成功，瀏覽器直接寫入驗證回 403，正常登入及自己的雲端資料讀取回 200。
3. 在受保護的環境執行 `node scripts/migrate_preview_backup.mjs --dry-run /private/path/backup.json`，預檢成功後執行 `node scripts/migrate_preview_backup.mjs /private/path/backup.json`。Supabase URL 與 service key 使用環境變數，不放命令列值。錯誤預檢不寫任何雲端資料；跨 Auth 與 REST 的搬移不是資料庫交易，中途失敗應保留備份並按腳本結果恢復，不可假設全部完成。
4. 接完並驗證管理 CRUD、密碼重設、停用、批次匯入與網路設定；本機管理寫入保持停用直到這些功能真正使用雲端。
5. 移除本機 ADMIN 備份登入分支，確認五級權限與 TXT 下載範圍；更新舊密碼並制定首次登入改密碼政策。
6. 設定公司出口 IP 並在公司 Wi-Fi／行動網路實測。現有 schema 以啟用的 allowed_networks 作為白名單：沒有啟用紀錄代表不限制；有紀錄則伺服器要求 IP 符合 CIDR。管理頁的 test/strict 設定尚未接線，不能當作已生效的開關。002 已套用，瀏覽器直接資料表寫入被拒絕；仍須接完管理網路設定並實測固定出口 IP，才能正式採用。
7. 完成 DNS 與 TLS 才能使用 `https://checkin.kimptondaan.com`；規劃中的域名不代表已啟用。

目前登入後的雲端資料自動重新查詢間隔為 15 秒，視窗重新取得焦點也會更新。這不是 Supabase Realtime；原管理資料尚未搬移及接線前，不能宣稱手機與電腦新增資料已互相同步。
