# 大安金普頓員工刷卡系統

## 目前狀態（2026-11-12）

原桌面備份的 **9 個部門、9 位員工、4 筆刷卡紀錄及 ADMIN 帳號**已搬移至 Supabase。已核對員工姓名、編號、部門、職稱、角色、啟用狀態與原刷卡時間，並逐一驗證 10 個雲端帳號可使用原密碼登入；既有雲端密碼沒有重設。主管姓名中有 3 個唯一對應員工，6 個舊自由文字姓名沒有對應，保留原文，不自行猜測指派。

**003_cloud_management.sql 已在遠端成功執行並核對結構與權限，新管理版尚待完成所有角色刷卡入口、正式部署及整合測試。** 直接瀏覽器修改角色、刷卡及管理 RPC 均回 403，匿名 RPC 回 401（預期保護）。原 9/9/4 及 10 個登入帳號再核對完整。使用者新增要求：IT、HR、部門主管與 Admin 同樣是員工，所有角色均需要自己刷卡與個人紀錄入口，不能靠提升權限處理。

## 程式結構

| 路徑 | 用途 |
| --- | --- |
| `src/App.tsx` | Supabase 登入、個人刷卡、五級權限管理介面、時間區間與 TXT 下載。 |
| `src/lib/supabase.ts` | 公開 Supabase client 與手機相容逾時控制。 |
| `src/lib/cloudStore.ts` | 使用 Auth access token 呼叫 `/api/attendance`；封裝雲端新增、儲存、匯入等動作。 |
| `src/lib/demoStore.ts` | 檔名保留相容性，內容只剩台北時區格式函數；無示範帳號、密碼、localStorage 寫入或重設。 |
| `netlify/functions/attendance-api.mjs` | 驗證登入及 active role、限制資料範圍，使用 service role 呼叫交易 RPC；刷卡時間取伺服器時間，IP 只信任 Netlify `context.ip`。 |
| `scripts/migrate_preview_backup.mjs` | 預檢、dry-run、穩定來源紀錄 UUID 的搬移腳本；不重設既有雲端密碼。 |
| `supabase/migrations` | 001 初始結構、002 禁止瀏覽器直接寫入、003 雲端管理與網路交易及稽核。 |

登入映射為 `{員工編號小寫}@checkin.kimptondaan.local`，`profiles.id` 等於 Auth user UUID；這是內部登入映射，不是收信用的電子郵件。

## 權限與雲端儲存設計

Admin 可管理員工、部門、角色、帳號狀態、密碼、補登與修改時間、網路設定及所有授權資料下載。HR 可管理員工與部門及非 Admin 角色，不能授予 Admin、重設密碼或修改刷卡時間；系統設定唯讀。IT 在出勤頁提供批次匯入與啟用／停用工具，不提供員工資料、部門或系統管理頁；IT 匯入只能建立一般員工。部門主管只查看與下載自己部門；一般員工只能刷卡及查看／下載自己紀錄。後端和資料庫均驗證角色，不能只依靠隱藏按鈕。

員工與部門修改採單一儲存動作；成功才結束編輯，失敗保留輸入。部門以 UUID 關聯，代號／名稱變更不改員工 UUID 或原紀錄對應。主管選單使用員工 UUID，可不指定，選取主管不會自行提升該員工角色；沒有對應 UUID 的舊姓名可明確保留。

新帳號依使用者指定採初始密碼 `00000000`，由 Supabase Auth 處理密碼，不是本機登入 fallback。正式使用前應修改管理者密碼並制定首次改密碼政策。稽核不保存密碼內容，前端不再提供含密碼的 JSON 預覽備份。

## 自動更新

新管理版部署後，操作成功立即重新讀取雲端。其他可見視窗每 15 秒自動重新查詢，視窗重新取得焦點也會更新；顯示最後成功同步時間。這不是 Supabase Realtime 推播，也不保證零延遲；頁面背景或裝置斷網時不持續更新。管理動作後強制取得寫入之後的新快照，避免在途舊查詢覆蓋新資料；未儲存的網路草稿不被自動更新清空。

## TXT 格式

台北時區（`Asia/Taipei`）每筆一行，依時間升序：`YYYYMMDDHHMM員工編號F1/F2`。上班 F1、下班 F2；無標題、逗號、引號或 UTF-8 BOM，以 CRLF 換行。下載區間以全部已授權紀錄篩選，不被畫面預設「今天」或搜尋偷偷限制。一般員工只下載自己，主管僅自己部門。

## Netlify 部署

GitHub main 為正式自動部署來源，建置 `pnpm run build`，輸出 `dist`，函式目錄 `netlify/functions`。必要環境變數為前端公開的 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`，及後端的 `SUPABASE_URL`（或前者 URL）、`SUPABASE_SERVICE_ROLE_KEY`。伺服器金鑰絕不可加 `VITE_` 或寫入 Git、TXT、前端 bundle。變數更新後須重新部署。

目前已授權 Netlify 設定使用 All scopes；不得將 service key 編入前端，每次交付前檢查 bundle。尚未套 003 時，不能把依賴該 SQL 的新後端推送到正式 main。

## 必要順序

1. 001、002 已在 Supabase 執行。原備份搬移與 10 個帳號驗證已完成，不需再提供備份或金鑰。
2. 003 已在 Supabase SQL Editor 執行成功，服務端管理 RPC、網路模式與稽核已核對；不重建或刪除來源員工、部門、刷卡資料。
3. 核對新增結構與授權成功後，推送管理版至 GitHub main，確認 Netlify production ready。
4. 使用專用、可清理的測試帳號驗證 CRUD、角色拒絕、補登、重複刷卡、匯入、停用、TXT 與自動更新；不建立真實員工的測試刷卡。
5. 公司固定 IP 依原需求先不設定。之後 Admin 設定白名單並啟用正式模式，須在公司 Wi-Fi 和行動網路實測；未知來源 IP 在正式模式必須拒絕。
6. 完成 DNS 與 TLS 後才使用 `https://checkin.kimptondaan.com`；規劃中的域名不代表已啟用。

原備份含舊版密碼，應保持私密且不可提交 Git。保留備份直到核對成功；重複執行搬移前先 dry-run，避免覆蓋之後的人員異動。
