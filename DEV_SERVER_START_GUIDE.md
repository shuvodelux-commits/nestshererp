# ডেভ সার্ভার চালু করার গাইড (WSL টার্মিনাল থেকে ম্যানুয়ালি)

আগে হয়তো একটা প্রজেক্টে শুধু `npm run dev` চালালেই সার্ভার চলে যেত। এই প্রজেক্টে সেটা কাজ করে না, কারণ এখানে আসলে **তিনটা আলাদা জিনিস** একসাথে লাগে:

1. **Postgres ডেটাবেজ** (Docker কনটেইনারে চলে)
2. **API সার্ভার** (`apps/api`) — এটা Postgres-এর সাথে কানেক্ট হয়
3. **Web সার্ভার** (`apps/web`, Vite) — এটা API-কে কল করে

রুট `package.json`-এর `pnpm dev` কমান্ডটা শুধু API সার্ভার চালায় (`apps/api`-এর `dev` স্ক্রিপ্ট চালিয়ে), Web সার্ভার আলাদাভাবে চালাতে হয়। আর `apps/api`-এর `dev` স্ক্রিপ্ট নিজে থেকে `.env` ফাইল লোড করে না (কোডে কোথাও `dotenv` ইমপোর্ট নেই), তাই `DATABASE_URL is required but not set` এই এরর আসে যদি এনভায়রনমেন্ট ভ্যারিয়েবল ম্যানুয়ালি লোড করা না হয়। এই কারণেই এই গাইডে `pnpm dev` না বলে `node --env-file=.env` দিয়ে সরাসরি চালানোর কথা বলা হয়েছে — এটাই এখন পর্যন্ত এই রিপোতে যাচাই করে দেখা কাজ করা পদ্ধতি।

---

## ১. Docker + Postgres চালু করা

প্রতিদিন প্রথমে এই দুইটা কমান্ড:

```bash
sudo service docker start      # WSL2-তে Docker daemon নিজে থেকে চালু হয় না
docker start sher-pg           # Postgres কনটেইনার চালু
docker ps                      # চেক করো sher-pg "Up" আছে কিনা
```

কনটেইনার আগে থেকেই চলতে থাকলে `docker start sher-pg` শুধু "already started" জাতীয় কিছু বলবে, সমস্যা নেই।

---

## ২. API সার্ভার (`apps/api`) চালু করা

### ২.১ — `.env` ফাইল আছে কিনা চেক করো

`apps/api/.env` ফাইলটা গিট-ইগনোর করা, তাই রিপোতে থাকে না — একবার বানিয়ে রাখলেই হবে। এখন এই রিপোতে যেটা আছে (আজ যাচাই করা):

```
PORT=3000
JWT_SECRET=dev-local-secret-do-not-use-in-production
GOOGLE_CLIENT_ID=1080471240756-3j1u5g0lip9p1d25lrju4bt1q47mhkta.apps.googleusercontent.com
DATABASE_URL=postgresql://postgres:dev@localhost:5432/sher_dev
TEST_DATABASE_URL=postgresql://postgres:dev@localhost:5432/sher_test
NODE_ENV=development
```

ফাইলটা না থাকলে `apps/api/.env` বানিয়ে উপরের কন্টেন্ট বসিয়ে দাও।

> `JWT_SECRET` এখানে শুধু লোকাল ডেভের জন্য বসানো একটা ভ্যালু — কোনো ডকুমেন্টেশনে এই ভ্যালু নির্দিষ্ট করে দেওয়া নেই, তাই প্রোডাকশনে এটা ব্যবহার করা যাবে না।

### ২.২ — বিল্ড + রান

```bash
cd ~/projects/shererp/apps/api
pnpm build
node --env-file=.env dist/main.js
```

`node --env-file=.env` না দিলে `.env`-এর ভ্যালুগুলো লোড হবে না, আর সার্ভার বুট হওয়ার সময়ই ক্র্যাশ করবে `DATABASE_URL is required but not set` এই এরর দিয়ে।

### ২.৩ — ব্যাকগ্রাউন্ডে চালাতে চাইলে

টার্মিনাল আটকে না রেখে ব্যাকগ্রাউন্ডে চালাতে:

```bash
cd ~/projects/shererp/apps/api
node --env-file=.env dist/main.js > /tmp/api-dev.log 2>&1 &
disown
```

লগ দেখতে:

```bash
tail -f /tmp/api-dev.log
```

সার্ভার বন্ধ করতে:

```bash
pkill -f "dist/main.js"
```

### ২.৪ — সার্ভার ঠিকমতো চলছে কিনা চেক

```bash
curl http://localhost:3000/health
```

`{"status":"ok"}` আসলে সার্ভার ঠিক আছে।

---

## ৩. Web সার্ভার (`apps/web`, Vite) চালু করা

```bash
cd ~/projects/shererp
pnpm --filter @sher/web dev
```

`vite.config.ts`-এ আগে থেকেই `host: true` সেট করা আছে, তাই আলাদা করে `--host` ফ্ল্যাগ দিতে হয় না — Vite এমনিতেই সব নেটওয়ার্ক ইন্টারফেসে (শুধু `localhost` না) বাইন্ড হবে, যাতে ফোন থেকেও অ্যাক্সেস করা যায়।

রেডি হলে এইরকম আউটপুট দেখাবে:

```
  VITE v5.4.21  ready in 616 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://172.x.x.x:5173/
```

ব্যাকগ্রাউন্ডে চালাতে:

```bash
pnpm --filter @sher/web dev > /tmp/web-dev.log 2>&1 &
disown
```

---

## ৪. ফোন থেকে অ্যাক্সেস করার জন্য (LAN forwarding — Windows সাইড)

WSL2-এর নিজস্ব আলাদা নেটওয়ার্ক আছে, তাই ফোন সরাসরি WSL-এর IP-তে কানেক্ট করতে পারে না — Windows-এর অ্যাড্রেসে কানেক্ট হয়, আর Windows থেকে WSL-এ ফরওয়ার্ড করতে হয়।

**গুরুত্বপূর্ণ:** `wsl --shutdown` দিলে WSL নতুন IP পায়, তাই এই ধাপটা **আবার** করতে হবে।

### ৪.১ — PowerShell **Administrator** হিসেবে চালু করো

Start মেনু → `PowerShell` লেখো → রাইট ক্লিক → **Run as administrator**।

### ৪.২ — স্ক্রিপ্ট চালাও

```powershell
powershell -ExecutionPolicy Bypass -File \\wsl.localhost\Debian\home\shoaib\projects\shererp\tools\lan-dev.ps1
```

এই স্ক্রিপ্ট নিজে থেকে:
- WSL-এর বর্তমান IP বের করে
- Windows পোর্ট `5173` → WSL IP-তে ফরওয়ার্ড করে
- ফায়ারওয়ালে রুল যোগ করে (Private নেটওয়ার্কের জন্য)
- ফোনে কোন URL খুলতে হবে সেটা প্রিন্ট করে

### ৪.৩ — আউটপুট থেকে URL নাও

স্ক্রিপ্ট শেষে এইরকম লাইন দেখাবে:

```
On your phone or tablet, open:  http://192.168.0.xxx:5173
```

এই URL-টা ফোনের ব্রাউজারে খোলো (ফোন আর পিসি একই ওয়াইফাইতে থাকতে হবে)।

---

## ৫. সাধারণ সমস্যা (ফোনে না খুললে)

| সমস্যা | সমাধান |
|---|---|
| নেটওয়ার্ক `Public` হয়ে আছে | Admin PowerShell-এ: `Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private` |
| ফোনে `ERR_ADDRESS_UNREACHABLE` | রাউটারে **AP Isolation / Client Isolation** চালু আছে — রাউটার সেটিংসে বন্ধ করো, না পেলে ফোনের **হটস্পট** ব্যবহার করো (পিসি-কে ফোনের হটস্পটে কানেক্ট করে নতুন IP দিয়ে ৪ নং ধাপ আবার করো) |
| WSL রিস্টার্ট করেছো (`wsl --shutdown`) | ৪ নং ধাপ পুরোটা আবার করতে হবে (নতুন WSL IP-এর জন্য) |
| API-তে `DATABASE_URL is required` এরর | `docker ps` দিয়ে চেক করো `sher-pg` চলছে কিনা, আর `.env` ফাইল আছে কিনা দেখো |
| Google sign-in-এ `redirect_uri_mismatch` | LAN IP দিয়ে Google sign-in কাজ করবে না (Google-এর জন্য https + পাবলিক ডোমেইন লাগে) — ফোনে পাসওয়ার্ড/PIN দিয়ে লগইন করো এর বদলে |

---

## ৬. প্রতিদিনের রুটিন (সংক্ষেপে)

```bash
# টার্মিনাল ১
sudo service docker start
docker start sher-pg

# টার্মিনাল ২ — API
cd ~/projects/shererp/apps/api
pnpm build && node --env-file=.env dist/main.js

# টার্মিনাল ৩ — Web
cd ~/projects/shererp
pnpm --filter @sher/web dev
```

ফোনের জন্য দরকার হলে, Admin PowerShell-এ:

```powershell
powershell -ExecutionPolicy Bypass -File \\wsl.localhost\Debian\home\shoaib\projects\shererp\tools\lan-dev.ps1
```

---

## ৭. লাইসেন্স (২০২৬-০৯-০২ থেকে বাধ্যতামূলক)

এখন থেকে ডিফল্ট `ENTITLEMENT_SOURCE=license` — অর্থাৎ **লাইসেন্স ছাড়া অ্যাপ READ_ONLY**: সব কিছু
পড়া যাবে, লগইন করা যাবে, ব্যাকআপ নেওয়া যাবে, কিন্তু নতুন কিছু সেভ হবে না। ডেভ মেশিনে যাতে
স্বাভাবিকভাবে কাজ করা যায়, সেজন্য `apps/api/.env`-এ দুইটা লাইন আছে:

```
LICENSE_KEY_PATH=/home/shoaib/projects/shererp/apps/api/licence/sher.licence
LICENSE_TRUSTED_KEYS=dev-1|<dev public key>|dev
```

**সাইনিং কী দুইটা, এবং কখনো এক নয়।** প্রোডাকশন কী দিয়ে কাস্টমারের লাইসেন্স সই হয়; ডেভ কী শুধু
এই মেশিনের জন্য। দুইটাই `~/.sher/licence-keys/` -এ থাকে (রিপোর মধ্যে নয়, ডেটাবেজে নয়,
`.sherdb`-তে নয়)। প্রাইভেট কী হারালে কোনো কাস্টমারকে আর রিনিউ দেওয়া যাবে না — **এনক্রিপ্ট করে
অফলাইনে ব্যাকআপ রাখো।**

```bash
pnpm licence:keygen                      # ডেভ কী (একবারই)
pnpm licence:keygen --kind prod          # প্রোডাকশন কী (একবারই, তারপর ব্যাকআপ)

# একটা লাইসেন্স বানানো (Business ID পাওয়া যায় Settings → Licence পেজে)
pnpm licence:issue --business <BUSINESS_ID> --days 365
pnpm licence:issue --business <BUSINESS_ID> --days 14        # ট্রায়াল = ছোট মেয়াদের লাইসেন্স
pnpm licence:issue --kind dev --business '*' --days 365      # এই ডেভ মেশিনের জন্য
```

লাইসেন্স ফাইল আর মেশিনের নিজস্ব হিসাব (`*.state.json`) `apps/api/licence/` -এ থাকে, এবং
`.gitignore` করা — দুইটাই এই কম্পিউটারের জিনিস, প্রোডাক্টের নয়।

শপ-এর দিক থেকে রিনিউ করতে টার্মিনাল লাগে না: **Settings → Licence** পেজে কী পেস্ট করলেই সঙ্গে
সঙ্গে চালু হয়, সার্ভার রিস্টার্ট ছাড়াই।
