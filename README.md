# LINE 群組翻譯機器人（繁體中文 ⇄ 印尼文）

一個部署在 **Render** 的 LINE Bot，把你、印尼外勞、Bot 拉進同一個群組後：

- 群組出現**繁體中文** → 立即翻成**印尼文**貼回群組
- 群組出現**印尼文** → 立即翻成**繁體中文**貼回群組
- 輸出格式：**`說話者暱稱：<譯文>`**

**翻譯引擎：Azure OpenAI（建議 gpt-5-mini）主翻 + Gemini 3.5 Flash-Lite 備援。**
- 主翻走 **Visual Studio Enterprise 每月 US$150 Azure 額度**：口語自然、資料不被拿去訓練、你的量費用趨近 NT$0。
- Azure 呼叫**相容新版（GPT-5 系列）與舊版模型**：先試新版參數，失敗自動退回舊版。
- Azure 失敗或未設定時，自動退回 **Gemini（免費層）**，不中斷。

回覆一律用 **Reply API（免費、不計 LINE 訊息額度）**，LINE 免費方案就夠用。

---

## 選哪個 Azure OpenAI 模型？（重要）

`gpt-4o-mini`、`gpt-4.1-mini` 都已被標為 **已棄用（Deprecated）**，**新訂閱無法部署**
（Azure 以「此訂閱過去是否部署過該模型」判定，VS Enterprise 訂閱多半沒有）。
因此請選 **GA（一般可用）狀態** 的模型：

| 模型 | 狀態 | 能否新部署 | 說明 |
|---|---|---|---|
| gpt-4o-mini | 已棄用 | ❌ | 你會看到「已棄用」訊息 |
| gpt-4.1-mini | 已棄用 | ⚠️ 多半不行 | — |
| **gpt-5-mini** | **GA** | ✅ | **推薦**：便宜、翻譯品質好 |
| gpt-5-nano | GA | ✅ | 更便宜、品質略低，也夠用 |

> 你每天 5~10 則，成本都趨近 NT$0，選 **gpt-5-mini** 即可。
> 程式已相容 GPT-5 系列（自動用 `max_completion_tokens`、不帶 `temperature`），
> 也相容舊版模型，所以未來換任何模型都不用改程式，只要改部署名稱。

---

## 運作原理

```
你 / 印尼外勞 ──發文字──▶ LINE 群組
                          │ webhook（含 replyToken + userId）
                          ▼
               Render Web Service (Node.js)
               1. 驗證 X-Line-Signature 簽章
               2. 取說話者暱稱
               3. 判斷語言方向（含漢字→翻印尼；否則→翻中文）
               4. Azure OpenAI 主翻（相容 GPT-5 / 舊版參數）
                  失敗 → 自動退 Gemini 3.5 Flash-Lite 備援
               5. 用 replyToken 回覆（免費）
                          │
                          ▼
               「暱稱：<譯文>」貼回同一群組
```

- **略過不翻**：純數字、emoji、網址、貼圖 / 圖片 / 語音（第一版只做純文字）。
- **不會無限迴圈**：Bot 自己發的訊息不會再觸發自己的 webhook。

---

## 事前準備：申請金鑰

### 1) LINE Messaging API（必填）

1. <https://developers.line.biz/console/> → 建 Provider → 建 **Messaging API channel**。
2. **Basic settings** → 複製 **Channel secret** → `CHANNEL_SECRET`
3. **Messaging API** → **Channel access token** 按 Issue → 複製 → `CHANNEL_ACCESS_TOKEN`
4. **Messaging API** 頁：**Use webhook** 開、**Allow bot to join group chats** 開、**Auto-reply / Greeting** 關。
5. **LINE Official Account Manager**（<https://manager.line.biz>）→ **設定 > 回應設定**：
   **聊天（Chat）關、Webhook 開**。

### 2) Azure OpenAI（主翻）取得 4 個值

1. **Azure Portal** → 建立資源 → **Azure OpenAI** → 建立
   （訂閱選 **Visual Studio Enterprise**；區域選 **Japan East** 等；定價層 Standard S0）。
2. 建好後 → 進 **Azure AI Foundry / Azure OpenAI Studio** → **Deployments** →
   **Create new deployment** → 模型選 **gpt-5-mini** → 取一個 **deployment name**（例如 `gpt-5-mini`）。
   - ⚠️ 這個 **deployment name** 就是 `AZURE_OPENAI_DEPLOYMENT`（不是資源名稱）。
   - 若 gpt-5-mini 在該區沒出現，換 gpt-5-nano，或換 East US 2 等區域重建資源。
3. 回資源頁 → **Keys and Endpoint**：
   - **Endpoint** → `AZURE_OPENAI_ENDPOINT`（例：`https://xxxx.openai.azure.com`）
   - **KEY 1** → `AZURE_OPENAI_KEY`
4. `AZURE_OPENAI_API_VERSION` 用預設 `2025-04-01-preview`（支援 GPT-5 系列）。

### 3) Gemini API Key（備援，可選但建議）

**Google AI Studio** <https://aistudio.google.com> → **Get API key** → `GEMINI_API_KEY`。
免費、不綁卡，當 Azure 掛掉時的安全網。

---

## 部署到 Render（Blueprint，Health Check 自動設好）

1. 推上 GitHub：
   ```bash
   cd line-translate-bot
   git init && git add . && git commit -m "init"
   git remote add origin https://github.com/<你的帳號>/line-translate-bot.git
   git branch -M main && git push -u origin main
   ```
2. <https://render.com> → **New +** → **Blueprint** → 選你的 repo（讀取 `render.yaml`）。
3. 部署時填入 `sync: false` 的環境變數：
   - 必填：`CHANNEL_ACCESS_TOKEN`、`CHANNEL_SECRET`
   - Azure：`AZURE_OPENAI_ENDPOINT`、`AZURE_OPENAI_KEY`、`AZURE_OPENAI_DEPLOYMENT`
   - Gemini：`GEMINI_API_KEY`（沒有就留空）
4. 完成得到網址，開網址看到 `LINE translate bot is running.` 即成功。

---

## 設定 LINE Webhook

1. LINE Console → **Messaging API** 頁 → **Webhook URL**（結尾要有 `/webhook`）：
   `https://你的render網址.onrender.com/webhook`
2. 按 **Verify** → Success；**Use webhook** 開啟。

---

## 把 Bot 加進群組

用手機加 Bot 為好友 → 建群組把**你 / 印尼外勞 / Bot** 都邀進去 → 打一句中文或印尼文測試。
加了卻不回覆，多半是 Auto-reply / 聊天模式沒關、或 Use webhook 沒開。

---

## 保活：避免 Render 休眠

Render 免費 Web Service 閒置滿 15 分鐘會休眠；**Health Check 屬內部探測、防不了休眠**，
需外部排程每 10 分鐘打 `/health`：

- **GitHub Actions（已內建 `.github/workflows/keep-alive.yml`）**：
  repo → Settings → Secrets and variables → Actions → New repository secret →
  Name `RENDER_URL`、Value `https://你的網址.onrender.com`（不加斜線）→ push 即生效。
- **cron-job.org**：URL `.../health`、每 10 分鐘。
- **Render 付費（約 US$7/月）**：不休眠，免保活工具。

---

## 常見問題與費用

**Q：建立部署時顯示「gpt-4o-mini 已棄用」？**
改選 **gpt-5-mini**（GA、可部署）。已棄用模型新訂閱無法部署。

**Q：Logs 出現 `Azure OpenAI HTTP 400`（參數相關）？**
程式會自動退回舊版參數重試；若仍失敗會退到 Gemini。通常代表模型參數規格較特殊，
可在 Azure 換 gpt-5-mini / gpt-5-nano。

**Q：Logs 出現 `Azure OpenAI HTTP 401/404`？**
401=金鑰或 endpoint 錯；404=`AZURE_OPENAI_DEPLOYMENT` 填錯（要填「部署名稱」）。
設定正確前，程式會自動退 Gemini，不會完全中斷。

**Q：會不會很花錢？**
每天 5~10 則：LINE（免費）+ Azure OpenAI（走 VS Enterprise 額度，月成本估 US$0.01~0.05）
+ Gemini 備援（免費層）+ Render（Free）= 幾乎 **NT$0**。

**Q：Azure OpenAI 會拿我的對話訓練嗎？**
不會。Azure OpenAI 明確不使用客戶輸入/輸出訓練模型，資料留在你的 Azure 租戶內。

**Q：貼圖 / 圖片 / 語音會翻嗎？**
第一版只做純文字，這些會被略過。

---

### 檔案結構

```
line-translate-bot/
├── index.js          # 主程式（Azure OpenAI 主翻[相容GPT-5] + Gemini 備援）
├── render.yaml       # Render Blueprint（自動設定服務 + Health Check /health）
├── package.json
├── .env.example
├── .gitignore
├── README.md
└── .github/workflows/keep-alive.yml   # GitHub Actions 防休眠
```
