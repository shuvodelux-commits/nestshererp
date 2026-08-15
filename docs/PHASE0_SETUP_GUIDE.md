# Phase 0 — সম্পূর্ণ সেটআপ গাইড

**Docker (Debian WSL2) থেকে NestJS প্রজেক্ট এবং প্রতিদিনের কাজ পর্যন্ত**

> এই গাইডে কমান্ড ইংরেজিতে, ব্যাখ্যা বাংলায়। কমান্ডগুলো হুবহু copy করে চালাবেন।

---

## Phase 0 তে আসলে কী হবে

Phase 0 তে **কোনো ব্যবসায়িক feature তৈরি হবে না**। কোনো POS নেই, কোনো product নেই, কোনো invoice নেই।

যা তৈরি হবে:

| জিনিস | কেন দরকার |
|---|---|
| **Boundary checker** | business logic যেন NestJS এর ভিতরে ঢুকে না যায় — CI নিজে ধরবে |
| **Money / Qty types** | টাকা আর stock এর হিসাব যেন কখনো ভুল না হয় |
| **Tenant context** | এক দোকানের data অন্য দোকান যেন না দেখে |
| **Write path template** | পরের ৩১টা module যেটা copy করে বানানো হবে |

**এই তিনটা জিনিস পরে যোগ করা যায় না।** তাই Phase 0 ধীর মনে হলেও এটাই সবচেয়ে গুরুত্বপূর্ণ ধাপ।

শেষে আপনি শুধু দেখবেন `GET /health` → `{"status":"ok"}`। এটাই সফলতা।

---

# ধাপ ১ — Debian WSL2 প্রস্তুত করা

## ১.১ WSL চালু করুন

Windows PowerShell এ:

```powershell
wsl -d Debian
```

এখন থেকে সব কমান্ড **Debian এর ভিতরে** চলবে।

## ১.২ System update

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential ca-certificates
```

## ১.৩ যাচাই করুন

```bash
cat /etc/debian_version    # সংস্করণ দেখাবে
git --version              # git এর version দেখাবে
```

---

# ধাপ ২ — Docker Engine ইনস্টল

> **Docker Desktop ইনস্টল করবেন না।** ওটা ৩–৪ GB নেয়। Docker Engine WSL এর ভিতরে ~৫০০ MB.

## ২.১ ইনস্টল

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

## ২.২ WSL restart করুন

Windows PowerShell এ:

```powershell
wsl --shutdown
```

তারপর আবার `wsl -d Debian` দিয়ে ঢুকুন।

## ২.৩ Docker service চালু করুন

Debian WSL এ systemd না থাকলে service নিজে চালু হয় না:

```bash
sudo service docker start
docker run hello-world
```

`Hello from Docker!` দেখালে ঠিক আছে।

## ২.৪ প্রতিবার চালু করার ঝামেলা কমান

`~/.bashrc` ফাইলের শেষে যোগ করুন:

```bash
# Docker auto-start
if ! service docker status > /dev/null 2>&1; then
    sudo service docker start > /dev/null 2>&1
fi
```

সংরক্ষণ করে:

```bash
source ~/.bashrc
```

**sudo password বারবার চাইলে** (ঐচ্ছিক):

```bash
echo "$USER ALL=(ALL) NOPASSWD: /usr/sbin/service docker *" | sudo tee /etc/sudoers.d/docker-service
```

---

# ধাপ ৩ — PostgreSQL চালু করা

## ৩.১ Container তৈরি

```bash
docker run --name sher-pg \
  -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=sher_dev \
  -p 5432:5432 \
  --restart unless-stopped \
  -d postgres:16
```

> **`postgres:16` — সংস্করণ পরিবর্তন করবেন না।** আপনার production server ও ১৬ চালাবে। আলাদা version মানে "আমার PC তে কাজ করে, server এ করে না" সমস্যা।

## ৩.২ Test database বানান

```bash
docker exec -it sher-pg psql -U postgres -c "CREATE DATABASE sher_test;"
```

**দুটো database কেন:**

| Database | কাজ |
|---|---|
| `sher_dev` | আপনি হাতে যে data দিয়ে পরীক্ষা করবেন |
| `sher_test` | automated test চালানোর সময় ব্যবহার হবে |

আলাদা না করলে test চালানোর সময় আপনার হাতে বানানো data মুছে যাবে — এবং সেটা সবসময় সবচেয়ে খারাপ সময়ে ঘটে।

## ৩.৩ যাচাই

```bash
docker ps
docker exec -it sher-pg psql -U postgres -l
```

দুটো database তালিকায় দেখা যাবে।

## ৩.৪ দরকারি কমান্ড

```bash
docker start sher-pg      # কাজ শুরুর সময়
docker stop sher-pg       # কাজ শেষে
docker logs sher-pg       # সমস্যা হলে
```

---

# ধাপ ৪ — Node.js ও pnpm

## ৪.১ nvm দিয়ে Node 20

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
nvm alias default 20
```

## ৪.২ pnpm

```bash
npm install -g pnpm@9
```

## ৪.৩ যাচাই

```bash
node -v     # v20.x.x
pnpm -v     # 9.x.x
```

---

# ধাপ ৫ — প্রজেক্ট ফোল্ডার ও Git

## ৫.১ ফোল্ডার তৈরি — জায়গাটা খুব গুরুত্বপূর্ণ

```bash
mkdir -p ~/projects/shererp
cd ~/projects/shererp
```

> ### ⚠️ সবচেয়ে বড় ভুল যেটা এড়াতে হবে
>
> ```bash
> ~/projects/shererp                          # ✅ ঠিক (WSL এর ভিতরে)
> /mnt/c/Users/Shoaib/Documents/shererp       # ❌ ভুল (Windows drive)
> ```
>
> Windows drive এ রাখলে `node_modules` এর কারণে **১০ গুণ ধীর** হবে। এটা WSL2 এর পরিচিত সমস্যা, কোনো সমাধান নেই।

Windows থেকে ফাইল দেখতে File Explorer এ লিখুন:

```
\\wsl$\Debian\home\<আপনার-username>\projects\shererp
```

## ৫.২ Git চালু

```bash
git init
git config user.name "SDelux"
git config user.email "shuvodelux@gmail.com"
```

## ৫.৩ Planning docs কপি করুন — এটা বাদ দেবেন না

```bash
mkdir -p docs
cp -r "/mnt/c/Users/Shoaib/Documents/SherERP NestJS/"*.md docs/
ls docs/
```

**কেন জরুরি:** AI agent তার নিয়ম `docs/` থেকে পড়ে। docs না থাকলে agent এর কোনো নিয়ম নেই — তখন সে নিজের ইচ্ছামতো আপনার হিসাবের logic বানাবে।

## ৫.৪ প্রথম commit

```bash
cat > .gitignore << 'EOF'
node_modules/
dist/
.env
.env.local
*.log
coverage/
.DS_Store
EOF

git add .
git commit -m "Planning package"
```

## ৫.৫ GitHub এ push

GitHub এ **private** repository বানান (নাম: `shererp`), তারপর:

```bash
git remote add origin https://github.com/<username>/shererp.git
git branch -M main
git push -u origin main
```

> **Private রাখবেন।** এটা আপনার ব্যবসায়িক সম্পদ।

---

# ধাপ ৬ — VS Code সেটআপ

## ৬.১ ইনস্টল

VS Code **Windows এ** ইনস্টল করুন (WSL এর ভিতরে নয়)।

## ৬.২ WSL extension

VS Code খুলে Extensions (`Ctrl+Shift+X`) → **WSL** (Microsoft) → Install

## ৬.৩ প্রজেক্ট খুলুন

Debian terminal থেকে:

```bash
cd ~/projects/shererp
code .
```

VS Code খুলবে। নিচে বাম কোণায় সবুজ রঙে **`WSL: Debian`** লেখা দেখতে হবে। না দেখালে সেটআপ ভুল হয়েছে।

## ৬.৪ Extensions (WSL এ ইনস্টল করুন)

- **ESLint**
- **Prettier**
- **Vue - Official**
- **Docker**

প্রতিটার পাশে "Install in WSL: Debian" লেখা বোতাম চাপবেন।

---

# ধাপ ৭ — AI Agent সেটআপ

## ৭.১ Claude Code

```bash
npm install -g @anthropic-ai/claude-code
cd ~/projects/shererp
claude
```

প্রথমবার login করতে বলবে।

**VS Code এর terminal এ চালান** (`` Ctrl+` `` দিয়ে terminal খুলুন) — তাহলে এক স্ক্রিনে কোড আর agent দুটোই থাকবে।

## ৭.২ কাজ ভাগ করে দিন

| Agent | কাজ |
|---|---|
| **Claude Code** | মূল কোড লেখা |
| **Codex / GPT** | **শুধু রিভিউ** — Claude যা লিখেছে তা পরীক্ষা করা |

রিভিউ prompt:

```
এই diff টা docs/AI_CODING_RULES.md এর বিপরীতে পরীক্ষা করো।

দেখো:
- business logic কি controller বা Vue file এ ঢুকেছে?
- money বা stock নিয়ে কি float ব্যবহার হয়েছে?
- tenant_id কি request body থেকে পড়া হয়েছে?
- কোনো test কি skip বা weak করা হয়েছে?
- ALLOWED FILES এর বাইরে কোনো ফাইল কি বদলেছে?

কোড লিখবে না। শুধু সমস্যাগুলো তালিকা করো।
```

**কেন দুটো agent:** যে agent bug লিখেছে, সে নিজের bug ধরতে পারে না। তার নিজের test তার নিজের ভুলের সাথে একমত হবে। ভিন্ন model ভিন্ন জিনিস দেখে। এটাই R-19 (আপনার সবচেয়ে বড় ঝুঁকি) এর বিরুদ্ধে সবচেয়ে সস্তা প্রতিরক্ষা।

---

# ধাপ ৮ — Prompt 0.1: Monorepo Skeleton

`docs/PHASE0_START_HERE.md` খুলুন।

**KERNEL block** (docs/00_PROMPT_KERNEL.md থেকে) আগে paste করুন, তারপর **Prompt 0.1**।

## যা হবে

Agent প্রথমে **PLAN** দেখাবে — কোড লিখবে না।

## ✋ এখানে থামুন এবং প্লান পড়ুন

দেখুন এই ৬টা package আছে কিনা:

```
packages/core-domain
packages/core-application
packages/core-contracts
packages/shared-utils
packages/adapter-postgres
apps/api
```

আর `tools/boundaries` — boundary checker।

**প্লান ভুল মনে হলে এখানেই থামান।** প্লান ঠিক করতে লাগে ৫ মিনিট, কোড ঠিক করতে লাগে ২ দিন।

## অনুমোদনের পর

Agent কোড লিখবে। শেষে বলুন:

```
Run: pnpm install && pnpm lint && pnpm typecheck && pnpm test:boundaries && pnpm test
Paste the real output with pass/fail counts.
```

## ✅ যা যাচাই করবেন

- [ ] চারটা কমান্ডই pass করেছে, **আসল output paste করা হয়েছে**
- [ ] boundary checker একটা ইচ্ছাকৃত ভুল ফাইল **ধরতে পেরেছে** (fixture test)
- [ ] `curl http://localhost:3000/health` → `{"status":"ok"}`

> **boundary checker সবার আগে কেন:** এটাই একমাত্র যান্ত্রিক সুরক্ষা R-03 এর বিরুদ্ধে — যে ঝুঁকিটা চুপচাপ আপনার offline পরিকল্পনা মেরে ফেলে। পরে যোগ করা যায় না, কারণ ততক্ষণে দেরি হয়ে গেছে।

```bash
git add . && git commit -m "Phase 0.1: monorepo skeleton + boundary checks"
```

---

# ধাপ ৯ — Prompt 0.2: Money, Qty, ULID, Clock

KERNEL + Prompt 0.2 paste করুন।

## ✅ যা নিজে যাচাই করবেন

এই দুটো নিজের চোখে দেখুন — এগুলোই পুরো সিস্টেমের ভিত্তি:

**১. allocate() ঠিকভাবে ভাগ করে:**

```
allocate(৳10.00, [1,1,1])  →  [334, 333, 333]   যোগফল ঠিক 1000
allocate(৳0.01, [1,1,1])   →  [1, 0, 0]         যোগফল ঠিক 1
```

**২. businessDate সঠিক:**

```
2026-08-15T18:30:00Z  +  Asia/Dhaka  →  "2026-08-16"
```

**কেন এই দুটো:**

- **allocate:** যোগফল হুবহু না মিললে landed cost আর discount এ প্রতি invoice এ এক পয়সা করে হারাবে — বছর শেষে inventory valuation আর ledger মিলবে না।
- **businessDate:** রাত ১২:৩০ এর বিক্রি Dhaka সময়ে আজকের, কিন্তু UTC তে গতকালের। ভুল হলে একদিনের পুরো বিক্রি অন্য দিনের রিপোর্টে চলে যাবে — এবং দুটো সংখ্যাই যুক্তিসঙ্গত দেখায় বলে মাসের পর মাস ধরা পড়ে না।

- [ ] Money আর Qty তে 100% branch coverage
- [ ] Determinism test: একই input ১০০ বার → একই output

```bash
git add . && git commit -m "Phase 0.2: money, qty, ulid, clock"
```

---

# ধাপ ১০ — Prompt 0.3: Tenant Context, Audit, Idempotency

KERNEL + Prompt 0.3 paste করুন।

## ✅ যা যাচাই করবেন

- [ ] Cross-tenant test **404** ফেরত দেয় (403 নয়)
- [ ] RLS সক্রিয় — raw query তেও অন্য tenant এর data আসে না
- [ ] Idempotency: একই `operation_id` দুবার → **একটাই** record
- [ ] Period lock: বন্ধ মাসে লিখতে গেলে `PERIOD_LOCKED`
- [ ] **৫০টা একসাথে document number → ৫০টা আলাদা, কোনো ফাঁক নেই**

> **শেষেরটা দুবার চালান।** একই invoice number দুবার তৈরি হওয়া এমন সমস্যা যেটা আপনি ধরবেন না — আপনার গ্রাহক ধরবে।

- [ ] Reference use case (`CreateNoteService`) write path এর ১০টা ধাপই মানে

```bash
git add . && git commit -m "Phase 0.3: tenant context, audit, idempotency, numbering"
git push
```

---

# প্রতিদিনের কাজের ধারা

## সকালে শুরু

```bash
wsl -d Debian
docker start sher-pg
cd ~/projects/shererp
code .
```

VS Code এ দুটো terminal:

```bash
# Terminal 1 — app চালু
pnpm dev

# Terminal 2 — agent
claude
```

## প্রতিটা slice এর চক্র

```
১. KERNEL + task block paste করুন
২. Agent PLAN দেয়          ← এখানে সবচেয়ে সস্তা checkpoint
৩. প্লান ভুল? এখানেই থামান
৪. অনুমোদন → agent কোড লেখে
৫. আসল test output চান     ← না দিলে আবার চান
৬. diff পড়ুন (Owner Checklist)
৭. নিজে manual scenario চালান
৮. commit করুন
```

**৭ নম্বর ধাপ কখনো বাদ দেবেন না।** যে agent bug লিখেছে তার test সেই bug এর সাথে একমত হবে। আগে থেকে লিখে রাখা সংখ্যা দিয়ে আপনার নিজের পরীক্ষাই একমাত্র স্বাধীন যাচাই।

## দিন শেষে

```bash
git add . && git commit -m "কী করলেন"
git push
docker stop sher-pg
```

**যতবার কিছু কাজ করে, ততবার commit করুন।** Commit হলো save point — বানাতে সস্তা, দরকারের সময় অমূল্য।

---

# দরকারি কমান্ড

```bash
# Database
docker start sher-pg
docker stop sher-pg
docker exec -it sher-pg psql -U postgres -d sher_dev

# Database সম্পূর্ণ মুছে নতুন করা
docker exec -it sher-pg psql -U postgres -c "DROP DATABASE sher_dev;"
docker exec -it sher-pg psql -U postgres -c "CREATE DATABASE sher_dev;"
pnpm db:migrate

# পরীক্ষা
pnpm lint
pnpm typecheck
pnpm test:boundaries
pnpm test

# Git
git status
git log --oneline
git diff
git checkout .          # সব পরিবর্তন বাতিল (সাবধান)
```

---

# সমস্যা হলে

| সমস্যা | সমাধান |
|---|---|
| `docker: command not found` | `sudo service docker start` |
| `permission denied` (docker) | `sudo usermod -aG docker $USER` → WSL restart |
| Port 5432 already in use | Windows এ PostgreSQL চলছে — বন্ধ করুন |
| pnpm খুব ধীর | কোড কি `/mnt/c/` এ? WSL এ সরান |
| VS Code এ `WSL: Debian` দেখায় না | WSL terminal থেকে `code .` দিন |
| Container বন্ধ হয়ে যায় | `docker logs sher-pg` দেখুন |
| Test fail, agent সংখ্যা বদলাতে চায় | **থামুন।** spec এর সংখ্যা ঠিক। কোড তদন্ত করুন |
| Agent ৪০টা ফাইল বদলেছে | পুরোটা বাতিল করুন। ALLOWED FILES আরো কড়া করে আবার দিন |
| diff বুঝতে পারছেন না | অন্য agent কে জিজ্ঞেস করুন: "এই পরিবর্তন কী করে, কী ভাঙতে পারে?" |
| গতকাল কাজ করত, আজ করে না | `git log` দেখুন — এজন্যই প্রতিবার commit করবেন |
| দিশেহারা লাগছে | শেষ ভালো commit এ ফিরে যান |

---

# Agent এর সাথে কথা বলার নিয়ম

**সবসময় বলবেন:**

> Run `pnpm lint && pnpm typecheck && pnpm test:boundaries && pnpm test` and paste the real output with pass/fail counts. If any command fails, the task is not complete.

**কখনো বলবেন না:** "make sure tests pass" — এটাই agent ফেরত বলে যখন সে আসলে চালায়নি।

| Agent বলে | আপনি বলবেন |
|---|---|
| "I need to install library X" | "না। নতুন dependency ছাড়া কীভাবে করবে?" |
| "I improved the business rule to…" | "থামো। OPEN_DECISIONS.md চূড়ান্ত। ফিরিয়ে দাও।" |
| "Tests should pass now" | "আসল output paste করো।" |
| "I also refactored other files" | "ALLOWED FILES এর বাইরে সব ফিরিয়ে দাও।" |
| "Normally you'd do it this way…" | "spec অনুসরণ করো। spec ভুল হলে জানাও — বদলাবে না।" |

**এক conversation এ একটা slice।** chat লম্বা হলে agent উপরের নিয়ম ভুলে যেতে থাকে। নতুন chat খুলুন, KERNEL আবার paste করুন।

---

# Phase 0 শেষ — চূড়ান্ত তালিকা

সব টিক না পড়া পর্যন্ত Phase 1 শুরু করবেন না।

**পরিবেশ**

- [ ] Docker Engine চলছে (Docker Desktop নয়)
- [ ] PostgreSQL 16 container চলছে
- [ ] `sher_dev` ও `sher_test` দুটোই আছে
- [ ] কোড `~/projects/` এ, `/mnt/c/` তে নয়
- [ ] VS Code এ `WSL: Debian` দেখাচ্ছে
- [ ] GitHub private repo তে push হয়েছে
- [ ] `docs/` ফোল্ডারে সব planning ফাইল আছে

**কোড**

- [ ] চারটা কমান্ডই সবুজ
- [ ] Boundary checker **প্রমাণিতভাবে** ভুল ধরে
- [ ] `Money.allocate()` হুবহু মেলে — আপনি নিজে যাচাই করেছেন
- [ ] `businessDate()` Dhaka মধ্যরাতে সঠিক
- [ ] Cross-tenant **404** দেয়
- [ ] RLS সক্রিয়
- [ ] ৫০টা concurrent number — আলাদা, ফাঁকহীন
- [ ] Idempotency: দুবার → একটা record
- [ ] Reference use case ১০ ধাপ মানে
- [ ] GitHub Actions CI চলছে ও merge আটকায়

**সব টিক পড়লে Phase 1 শুরু করুন** — Tenant, Auth, Users, Roles, Settings, Audit + deployment-mode providers (D-21/22/23/24)।

---

# সৎ প্রত্যাশা

- **Phase 0 তে দেখানোর মতো কিছুই থাকবে না।** শুধু `/health`. এটাই স্বাভাবিক।
- **Phase 5 আপনার প্রথম আসল মাইলফলক** — মাল কিনুন, stock এ দেখুন, সরবরাহকারীকে টাকা দিন, ledger আর cash মিলে যাক। এটা হলে architecture প্রমাণিত।
- **টাকার হিসাবে অন্তত একবার ভুল হবেই।** সেজন্যই invariant আর manual scenario আছে। ওগুলো ধরবে — যদি আপনি সত্যিই চালান।
- **boundary checker বাদ দিয়ে feature এ যেতে ইচ্ছা করবে।** করবেন না। এই একটা জিনিসই পরে যোগ করা যায় না।
- **আপনার সবচেয়ে বড় ঝুঁকি খারাপ AI কোড নয়** — ভালো দেখতে AI কোড সংখ্যা যাচাই না করে গ্রহণ করা। প্রতিরক্ষা একটাই অভ্যাস: **প্রত্যাশিত সংখ্যা আগে লিখুন, তারপর নিজে মিলিয়ে দেখুন।**
