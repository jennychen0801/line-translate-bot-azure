# LINE 群組翻譯機器人（繁體中文 ⇄ 印尼文）

一個部署在 **Render** 的 LINE Bot。把你、印尼外勞和 Bot 拉進同一個群組之後：

- 群組出現**繁體中文** → 立即翻成**印尼文**貼回群組
- 群組出現**印尼文** → 立即翻成**繁體中文**貼回群組
- 輸出格式：**`說話者暱稱：<譯文>`**

**翻譯引擎：Azure OpenAI（gpt-5-mini）主翻 + Gemini 3.1 Flash-Lite 備援。**

- 主翻用的是 **Visual Studio Enterprise 每月 US$150 Azure 額度**：翻譯口語自然，資料不會被拿去訓練，以這個用量費用趨近 NT$0。
- Azure 預設走 **v1 API**（`/openai/v1/chat/completions`，不需要 `api-version`）；v1 回 404 才自動改走舊版 deployments 路徑。
- 同時相容 **GPT-5 系列與舊版模型**：先用新版參數（`max_completion_tokens` + `reasoning_effort: minimal`），參數不相容時自動改用舊版參數（`max_tokens` + `temperature`）。
- Azure 失敗或沒設定時，自動改用 **Gemini（免費層）**，服務不中斷。

回覆一律用 **Reply API**（免費，不計入 LINE 訊息額度），所以 LINE 免費方案就夠用。

---

## 環境變數總表

| 變數                         | 必填 | 預設值                    | 說明                                                                                                                                                |
| ---------------------------- | ---- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANNEL_ACCESS_TOKEN`     | ✅   | —                        | LINE Messaging API token                                                                                                                            |
| `CHANNEL_SECRET`           | ✅   | —                        | LINE Channel secret（用來驗證 webhook 簽章）                                                                                                        |
| `AZURE_OPENAI_ENDPOINT`    | 主翻 | —                        | 例：`https://xxxx.openai.azure.com` 或 `https://xxxx.cognitiveservices.azure.com`。結尾多打 `/`、`/openai`、`/openai/v1` 程式都會自動去掉 |
| `AZURE_OPENAI_KEY`         | 主翻 | —                        | Keys and Endpoint 頁的 KEY 1                                                                                                                        |
| `AZURE_OPENAI_DEPLOYMENT`  | 主翻 | —                        | **部署名稱**（deployment name），不是模型名稱，也不是資源名稱                                                                                 |
| `AZURE_OPENAI_API_VERSION` | ❌   | `2025-04-01-preview`    | **只有 v1 回 404、改走舊版路徑時才會用到**。正常情況不必理會                                                                                  |
| `GEMINI_API_KEY`           | 備援 | —                        | Google AI Studio 的 API key                                                                                                                         |
| `GEMINI_MODEL`             | ❌   | `gemini-3.1-flash-lite` | ⚠️ Render Dashboard 上設定的值會**蓋過**程式預設值，換模型時要記得改這裡                                                                    |
| `DEBUG_TOKEN`              | ❌   | —                        | 設定後才會開放`/debug/translate` 線上診斷端點；沒設定時這個端點回 404                                                                             |
| `PORT`                     | ❌   | `3000`                  | Render 會自動注入                                                                                                                                   |

> Azure 和 Gemini 至少要設定其中一組，不然程式啟動時就會直接結束（`[FATAL]`）。

---

## 選哪個模型？

### Azure OpenAI

`gpt-4o-mini`、`gpt-4.1-mini` 已經被標為**已棄用（Deprecated）**，新訂閱多半無法部署。請選 **GA** 模型：

| 模型                 | 狀態         | 能否新部署    | 說明                             |
| -------------------- | ------------ | ------------- | -------------------------------- |
| gpt-4o-mini          | 已棄用       | ❌            | 部署時會看到「已棄用」訊息       |
| gpt-4.1-mini         | 已棄用       | ⚠️ 多半不行 | —                               |
| **gpt-5-mini** | **GA** | ✅            | **推薦**：便宜，翻譯品質好 |
| gpt-5-nano           | GA           | ✅            | 更便宜，品質略低但也夠用         |

> GPT-5 系列預設會「推理」（`reasoning_effort: medium`），簡單一句翻譯也可能要 5–15 秒，推理用的 token 也會吃掉輸出額度。
> 程式已固定送 `reasoning_effort: 'minimal'`，回應大約 1–3 秒。

### Gemini（備援）

| 模型                            | 實測延遲 | 說明                                           |
| ------------------------------- | -------- | ---------------------------------------------- |
| **gemini-3.1-flash-lite** | ~2 秒    | **目前預設**                             |
| gemini-3.5-flash-lite           | ~34 秒   | ❌ 太慢，會撞到 20 秒逾時，replyToken 也會過期 |

> Gemini 3 系列**不要調低 `temperature`**：Google 官方警告調低會造成 looping，模型生成停不下來，一路拖到逾時。
> 程式偵測到模型名稱含 `gemini-3` 時，不會送 temperature，改送 `thinkingConfig: { thinkingLevel: 'minimal' }`；其他模型則照舊送 `temperature: 0.3`。
> 想換模型時，先用下方的 `/debug/translate?model=...` 量延遲，**挑小於 5 秒的**。

---

## 運作原理

```
你 / 印尼外勞 ──發文字──▶ LINE 群組
                          │ webhook（含 replyToken + userId）
                          ▼
               Render Web Service (Node.js)
               1. 驗證 X-Line-Signature 簽章，立即回 200
               2. 取說話者暱稱（與翻譯並行）
               3. 判斷語言方向（含漢字→翻印尼；否則→翻中文）
               4. Azure OpenAI 主翻（v1 API，15s 逾時）
                  失敗 → Gemini 備援（20s 逾時，逾時不重試）
               5. 用 replyToken 回覆（免費）
                          │
                          ▼
               「暱稱：<譯文>」貼回同一群組
```

- **略過不翻**：純數字、emoji、網址，以及貼圖、圖片、語音（目前只處理純文字）。
- **不會無限迴圈**：Bot 自己發的訊息不會再觸發自己的 webhook。
- **重試策略**：
  - Azure 遇到參數不相容的 400，換舊版參數重試一次；v1 路徑 404，改走舊版路徑。
  - Gemini 遇到 500 / 503 最多重試 2 次；遇到 429 限流重試 1 次；**逾時不重試**，因為同一個請求再等一輪只會讓 replyToken 過期。

---

## 事前準備：申請金鑰

### 1) LINE Messaging API（必填）

1. 到 [https://developers.line.biz/console/](https://developers.line.biz/console/) → 建立 Provider → 建立 **Messaging API channel**。
2. **Basic settings** → 複製 **Channel secret**，填入 `CHANNEL_SECRET`。
3. **Messaging API** → **Channel access token** 按 Issue → 複製，填入 `CHANNEL_ACCESS_TOKEN`。
4. **Messaging API** 頁：**Use webhook** 開，**Allow bot to join group chats** 開，**Auto-reply / Greeting** 關。
5. **LINE Official Account Manager**（[https://manager.line.biz](https://manager.line.biz)）→ **設定 > 回應設定**：**聊天（Chat）關，Webhook 開**。

### 2) Azure OpenAI（主翻）

1. **Azure Portal** → 建立資源 → **Azure OpenAI**（訂閱選 **Visual Studio Enterprise**，區域選 **Japan East** 等，定價層選 Standard S0）。
2. 進 **Azure AI Foundry** → **Deployments** → **Create new deployment** → 模型選 **gpt-5-mini** → 取一個 deployment name（例如 `gpt-5-mini`）。
   - ⚠️ 這個 **deployment name** 就是 `AZURE_OPENAI_DEPLOYMENT`。
   - 如果 gpt-5-mini 在這個區域沒出現，可以改用 gpt-5-nano，或換到 East US 2 等區域重建資源。
3. 回到資源頁 → **Keys and Endpoint**：
   - **Endpoint** 填入 `AZURE_OPENAI_ENDPOINT`
   - **KEY 1** 填入 `AZURE_OPENAI_KEY`
4. `AZURE_OPENAI_API_VERSION` **不用設定**，v1 API 不需要它。

**部署前先在本機驗證**（PowerShell，應該回 200 並帶 `choices`）：

```powershell
$h = @{ 'api-key' = '<AZURE_OPENAI_KEY>'; 'Content-Type' = 'application/json' }
$b = '{"model":"<DEPLOYMENT>","messages":[{"role":"user","content":"翻成印尼文：你好"}],"max_completion_tokens":256,"reasoning_effort":"minimal"}'
Invoke-RestMethod -Method Post -Uri '<ENDPOINT>/openai/v1/chat/completions' -Headers $h -Body $b
```

### 3) Gemini API Key（備援，選用但建議設定）

到 **Google AI Studio** [https://aistudio.google.com](https://aistudio.google.com) → **Get API key**，填入 `GEMINI_API_KEY`。免費、不用綁卡。

**驗證並量延遲：**

```powershell
Measure-Command { Invoke-RestMethod -Method Post -ContentType 'application/json' `
  -Uri "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=<GEMINI_KEY>" `
  -Body '{"contents":[{"parts":[{"text":"翻成印尼文：你好"}]}],"generationConfig":{"thinkingConfig":{"thinkingLevel":"minimal"}}}' }
```

---

## 本機執行

```bash
cp .env.example .env   # 填入實際值
npm install
node --env-file=.env index.js   # Node 20.6+ 內建讀 .env，不需 dotenv
```

本機要接收 LINE webhook 的話，需要用 ngrok / cloudflared 開一個對外 URL，再填到 LINE Console 的 Webhook URL。
只想測翻譯引擎的話，在 `.env` 設好 `DEBUG_TOKEN`，直接打 `http://localhost:3000/debug/translate?token=...` 即可。

---

## 部署到 Render

1. 推上 GitHub（`main` 分支；`render.yaml` 已設 `autoDeploy: true`，之後 push 就會自動部署）。
2. 到 [https://render.com](https://render.com) → **New +** → **Blueprint** → 選這個 repo（會讀取 `render.yaml`）。
3. 填入 `sync: false` 的環境變數：
   - 必填：`CHANNEL_ACCESS_TOKEN`、`CHANNEL_SECRET`
   - Azure：`AZURE_OPENAI_ENDPOINT`、`AZURE_OPENAI_KEY`、`AZURE_OPENAI_DEPLOYMENT`
   - Gemini：`GEMINI_API_KEY`
   - `DEBUG_TOKEN` 在 Blueprint 中設為 `generateValue: true`，Render 會自動產生，可以到 Dashboard 查看。
4. 部署完成後打開網址，看到 `LINE translate bot is running.` 就代表成功。

> ⚠️ **不是用 Blueprint 建立的服務**（手動 New Web Service），`render.yaml` 不會生效。
> 要自己到 **Environment** 把上表的變數補齊，特別是 `GEMINI_MODEL` 和 `DEBUG_TOKEN`。
>
> ⚠️ 改了 `render.yaml` 的預設值（例如 `GEMINI_MODEL`），**已經存在的服務不會自動跟著改**，要到 Dashboard 手動更新。

---

## 線上驗證：`/debug/translate`

這個端點用 **Render 上實際設定的金鑰和模型**跑一次翻譯，回傳延遲、譯文或錯誤訊息。不用進 LINE 群組，也不用翻 log，就能確認上線版本能不能正常運作。

### 設定 `DEBUG_TOKEN`

`DEBUG_TOKEN` 就是一串你自己產生的長亂碼。設在 Render 環境變數裡，再當成網址參數 `token` 帶上，才能打開這個端點。

**1. 產生 token（PowerShell）**

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | % {[char]$_})
```

會印出 32 字元的英數字。只用英數字，放進網址不用另外編碼。

**2. 設到 Render**

1. 打開 [https://dashboard.render.com](https://dashboard.render.com)，點你的服務（`line-translate-bot`）。
2. 左側選 **Environment**。
3. 先看清單裡有沒有 `DEBUG_TOKEN`：
   - **已經有**（用 Blueprint 建立時 `generateValue: true` 自動產生的）：點眼睛圖示就能看到值，直接拿來用，不用做第 1 步。
   - **沒有**：按 **+ Add Environment Variable**，Key 填 `DEBUG_TOKEN`，Value 貼上第 1 步產生的值。
4. 順便確認 `GEMINI_MODEL` 是不是 `gemini-3.1-flash-lite`，不是就一起改。
5. 按 **Save, rebuild, and deploy**（只按 Save 不會套用到正在跑的服務）。
6. 等 **Events** 顯示 `Deploy live`，大約 1–2 分鐘。

**本機（選用）：** 在 `.env` 設 `DEBUG_TOKEN=<你的值>`，執行 `node --env-file=.env index.js`，然後打開 `http://localhost:3000/debug/translate?token=...`。

### 使用方式

```
https://<你的服務>.onrender.com/debug/translate?token=<DEBUG_TOKEN>&engine=all
```

| 參數       | 預設                         | 說明                                                                                                        |
| ---------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `token`  | —                           | 必填，要等於`DEBUG_TOKEN`；不符或沒設定時回 404。自己產生的長亂碼 (上述)。                                |
| `engine` | `all`                      | `azure` / `gemini` / `all`（同時跑兩個並比較）                                                        |
| `text`   | `你好，今天晚上要加班嗎？` | 測試句；可以換成印尼文測反方向，例如`Besok saya libur`。中文要先做 URL 編碼，不過瀏覽器網址列會自動處理。 |
| `model`  | `GEMINI_MODEL`             | 臨時覆寫 Gemini 模型，**不用改環境變數、不用重新部署**就能比較不同模型，例如 gemini-2.5-flash`。`   |

回傳範例：

```json
{
  "input": "你好，今天晚上要加班嗎？",
  "direction": "zh-Hant->id",
  "results": [
    { "engine": "azure-openai (gpt-5-mini, v1)", "ok": true, "ms": 1450, "output": "Halo, malam ini lembur nggak?" },
    { "engine": "gemini (gemini-3.1-flash-lite)", "ok": true, "ms": 1800, "output": "Halo, malam ini lembur?" }
  ]
}
```

- `ok: true` 而且 `ms` < 5000 → 正常。
- `engine` 名稱中的 `v1` / `legacy` 表示 Azure 目前走哪一條路徑。
- `ok: false` → 看 `error` 欄位，對照下方的「依 log 排錯」。

### 打不開時

| 結果                                     | 代表什麼                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| 回傳 JSON，`results` 裡有 `ok: true` | ✅ 設定成功，翻譯引擎也正常                                                      |
| 空白頁 / 404                             | token 打錯、`DEBUG_TOKEN` 沒設定，或還沒部署完。確認 Events 是 `Deploy live` |
| `Cannot GET /debug/translate`          | 跑的還是舊版程式，最新的 commit 沒部署上去。到 Events 確認最新部署的 commit      |

### 安全注意事項

- token 是放在網址裡的，所以會留在瀏覽器歷史紀錄和 Render 的 request log 裡。**不要把完整網址貼到公開的地方。**
- 外洩的話，到 Render 換一個新值，再 **Save, rebuild, and deploy**，舊的就失效了。
- 最糟的情況是被別人拿去狂打這個端點，耗掉 Azure 和 Gemini 額度，不會外洩其他金鑰。
- 只是偶爾檢查的話，可以測完就把 `DEBUG_TOKEN` 刪掉，端點會恢復成 404。

---

## 設定 LINE Webhook

1. LINE Console → **Messaging API** 頁 → **Webhook URL**（結尾要有 `/webhook`）：`https://你的render網址.onrender.com/webhook`
2. 按 **Verify**，顯示 Success；確認 **Use webhook** 已開啟。
3. 建議同時打開 **Webhook redelivery**：冷啟動時沒送達的事件，LINE 會重送。（重送的事件 replyToken 可能已經過期，不保證一定能回覆。）

---

## 把 Bot 加進群組

用手機加 Bot 為好友 → 建立群組，把**你、印尼外勞、Bot** 都邀進去 → 打一句中文或印尼文測試。

---

## 保活：避免 Render 休眠（重要）

Render 免費方案的 Web Service 閒置 15 分鐘就會休眠，冷啟動要 30–60 秒以上。**LINE 的 webhook 等不了這麼久，冷啟動期間進來的訊息會直接遺失**，表現出來就是「放一陣子後第一則沒翻，之後又正常」。

Health Check 是 Render 內部的探測，**防不了休眠**，必須靠外部排程定時打服務。

| 方案                                     | 可靠度               | 說明                                                                                                               |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **cron-job.org**                   | ✅**推薦**     | 免費，時間準。URL 設`https://<服務>.onrender.com/health`，**每 5 分鐘**一次                                |
| UptimeRobot                              | ✅                   | 免費方案每 5 分鐘一次，還附停機通知                                                                                |
| GitHub Actions（內建`keep-alive.yml`） | ⚠️**不可靠** | 雖然設定每 10 分鐘，但 GitHub 會壓低免費 repo 的排程頻率，**實際好幾個小時才跑一次**，擋不住休眠。只能當輔助 |
| Render 付費（約 US$7/月）                | ✅                   | 不會休眠，不需要保活                                                                                               |
| Azure App Service B1 + Always On         | ✅                   | 約 US$13/月，可以從 VS Enterprise 額度扣，等於免費，而且和 Azure OpenAI 在同一個雲                                 |

> 進階用法：cron-job.org 改打 `/debug/translate?token=...&engine=gemini`，保活的同時也監控備援是否正常（失敗時 cron-job.org 會寄信通知）。代價是每天約 288 次 Gemini 呼叫。

GitHub Actions 的設定方式（作為輔助）：repo → Settings → Secrets and variables → Actions → New repository secret → Name 填 `RENDER_URL`，Value 填 `https://你的網址.onrender.com`（結尾不加斜線）。

---

## 依 log 排錯

到 Render Dashboard → **Logs**，對照下表：

| Log 訊息                                                 | 原因                                                       | 處理方式                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `[reply] (azure-openai) ...`                           | ✅ 正常，由主翻回覆                                        | —                                                                       |
| `[reply] (gemini) ...`                                 | 主翻失敗，由備援回覆                                       | 往上找`[translate] Azure OpenAI 失敗` 那一行，看原因                   |
| `Azure OpenAI HTTP 400: ... API version not supported` | 舊版程式走 deployments 路徑，帶了不支援的 api-version      | 更新到最新程式（已改走 v1 API）                                          |
| `[azure] v1 路徑 404，改用舊版 deployments 路徑`       | 這個資源不支援 v1 API                                      | 如果接著又出現 400 / 404，請確認 endpoint 和`AZURE_OPENAI_API_VERSION` |
| `Azure OpenAI HTTP 401`                                | 金鑰錯誤，或金鑰和 endpoint 不是同一個資源                 | 重新複製 KEY 1 和 Endpoint                                               |
| `Azure OpenAI HTTP 404 ... DeploymentNotFound`         | `AZURE_OPENAI_DEPLOYMENT` 填錯                           | 填 Foundry 裡的**部署名稱**                                        |
| `Azure OpenAI 失敗：This operation was aborted`        | Azure 超過 15 秒沒回應                                     | 確認有沒有送`reasoning_effort: minimal`（舊版程式沒有）                |
| `Gemini 逾時（>20000ms，model=...）`                   | 這個模型太慢                                               | 用`/debug/translate?model=...` 挑一個更快的，再改 `GEMINI_MODEL`     |
| `Gemini HTTP 400 ... thinking`                         | 這個模型不支援`thinkingLevel: minimal`                   | 換模型，或修改`translateWithGemini` 中的 `thinkingConfig`            |
| `Gemini HTTP 403`                                      | key 所屬的專案沒有啟用 API，或 key 設了 IP / referrer 限制 | 到 Google Cloud Console 檢查這把 key 的限制設定                          |
| `Gemini 每日免費額度已用盡（429）`                     | 免費額度用完了                                             | 台灣時間下午 4 點重置                                                    |
| `[handleEvent] ... Invalid reply token`                | 處理太久，replyToken 已過期                                | 通常是主翻和備援都很慢，先用`/debug/translate` 量延遲                  |
| `[getSpeakerName] 取暱稱失敗`                          | 拿不到暱稱（不影響翻譯）                                   | 會以「對方」顯示                                                         |
| 傳了訊息但**完全沒有 log**                         | 服務在休眠，冷啟動期間訊息遺失；或 webhook 沒設定好        | 見「保活」；到 LINE Console 按 Verify 確認                               |
| 有`[reply]` 但群組沒看到訊息                           | Bot 不在那個群組，或聊天模式沒關                           | 確認 LINE OA Manager 回應設定：聊天關、Webhook 開                        |

---

## 常見問題與費用

**Q：會不會很花錢？**
每天 5~10 則：LINE（免費）+ Azure OpenAI（走 VS Enterprise 額度，每月估 US$0.01~0.05）+ Gemini 備援（免費層）+ Render（Free），合計幾乎是 **NT$0**。

**Q：Azure OpenAI 會拿我的對話去訓練嗎？**
不會。Azure OpenAI 明確不使用客戶的輸入和輸出來訓練模型。

**Q：Gemini 免費層會拿資料去訓練嗎？**
Google AI Studio 免費層的資料**可能**會被用於改善產品。介意的話，不要設定 `GEMINI_API_KEY`（那就沒有備援），或者改用付費層。

**Q：貼圖、圖片、語音會翻嗎？**
目前只處理純文字，這些都會略過。

---

### 檔案結構

```
line-translate-bot-azure/
├── index.js          # 主程式（Azure OpenAI v1 主翻 + Gemini 備援 + /debug/translate）
├── render.yaml       # Render Blueprint（服務設定 + Health Check /health + 環境變數）
├── package.json
├── .env.example      # 環境變數範本
├── .gitignore
├── README.md
└── .github/workflows/keep-alive.yml   # GitHub Actions 保活（輔助用，不可靠）
```

### HTTP 端點

| 方法 | 路徑                 | 說明                                          |
| ---- | -------------------- | --------------------------------------------- |
| GET  | `/`                | 顯示`LINE translate bot is running.`        |
| GET  | `/health`          | 回`OK`，給保活排程和 Render Health Check 用 |
| GET  | `/debug/translate` | 線上診斷翻譯引擎（需要`DEBUG_TOKEN`）       |
| POST | `/webhook`         | LINE webhook 入口（會驗證簽章）               |
