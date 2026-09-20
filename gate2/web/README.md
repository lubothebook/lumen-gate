# gate2/web — Burn Ekranı + Taşıma Kanıtım (F6)

Gate 2.0’nın ayrı Vite uygulaması. `frontend/` ve `vercel.json` Gate 1.0
bölgesidir; bu uygulama onlara dokunmaz. Üretimde tek Vercel dağıtımının
`/gate2/` alt yolundan servis edilir (1.0 kökte, 2.0 `/gate2/`’de);
geliştirmede ayrı portta (5174) çalışır ve 1.0 dev sunucusu `/gate2`’yi
buraya proxy’ler — yani yerel deneyim Vercel’in birebir aynısıdır.

Görsel dil 1.0 ile aynıdır: ızgara duvar, cam kutucuklar, 1.0 / 2.0 anahtarı.
2.0 kutucuğuna basınca alttaki siyah bant bu sürümün konsolu olur (Burn,
Taşıma Kanıtım, Batarya, Biletlerim — tek ekran, sekme ile). 1.0 kutucuğu
dondurulmuş konsola döner.

## Çalıştırma

```
cd gate2/web
npm install
npm run dev        # http://localhost:5174/gate2/
                   # (1.0 konsolu açıksa: http://localhost:5173/gate2/)
```


## Dürüstlük kuralları (DIRECTIVE 2.0)

- Tüm sözleşme adresleri `deployments/testnet-2.0.json` makbuzundan okunur
  (`src/config.js`); elle kopyalanmış adres yoktur.
- Sahte veri yok: kayıt yoksa “kayıt yok”, router yoksa “router yok” yazar.
- Burn Ekranı şu an **bilinçli olarak bloke**: BurnRouter Sepolia’de kurulu
  değil (F2, Sepolia fonu bekliyor — Bolum 10 stop-raporu). StrKey doğrulaması
  ve USDC trustline kontrolü ise gerçek Horizon/RPC verisiyle **şimdi çalışır**.

## Sayfalar

- **Taşıma Kanıtım:** G… adresi (veya Freighter bağlantısı) için her iki canlı
  `gate_claim` dağıtımında `get_migration`, `proofs_of` → `get_proof`/`get_meta`/
  `owner_of` okumaları ve kampanya `claim_tier` (önce salt-okunur simülasyon,
  Freighter bağlıysa gerçek imzalı tx).
- **Burn Ekranı:** dürüst blokaj durumu + iki çalışan ön koşul (StrKey,
  trustline) + geri alınamazlık onayı (“BURN” yazmadan ve router olmadan buton
  asla açılmaz).

## Kanıt

`gate2/scripts/check-gate2-web.mjs` — gerçek headless tarayıcıda 17 kontrol:
canlı testnet RPC okumaları (kayıt yok ×2, 0 NFT ×2, claim_tier → Error #3
NoMigration), Horizon trustline (deployer’da USDC yok), StrKey geçerli/geçersiz,
BURN eyleminin router yokken kullanılamaz kalması **ve basıldığında gerekçesini
yazması**, 0 başarısız istek. Koşum:

```
NODE_PATH=<repo>/node_modules node gate2/scripts/check-gate2-web.mjs
```

## Gerçek cüzdan kanıtı

`gate2/scripts/verify-real-wallet.mjs` — butonların yalnız cevap vermediğini,
testnet üzerinde **gerçek değer hareket ettirdiğini** kanıtlar. Aynı koşumda
yeni bir anahtar üretir, Friendbot ile fonlar, sayfa açılmadan önce gerçek
Freighter API yüzeyiyle aynı biçimde bir cüzdan enjekte eder (imzalar gerçek
ed25519 imzasıdır) ve iki kapiyi de tıklar: USDC trustline (ChangeTrust),
TESTNET damgası `stamp(owner)` ve bump gerçek işlem olarak gönderilir,
claim_tier zincirin kendi reddiyle (NoMigration #3) döner, 1.0 burn akışı
zincire kadar gidip wSRC trustline’ı olmayan hesap için sözleşmenin kendi
cevabını raporlar. Çalıştırma:

```
cd gate2/scripts && npm install
cd ../web && npm run dev &                # :5174/gate2/
node ../../tools/api-dev-server.js &      # :3001 (1.0 /api katmanı)
cd ../../frontend && npm run dev &        # :5173
node gate2/scripts/verify-real-wallet.mjs
```

## Kontrol sözleşmesi

Erişilemez bir eylem ölü buton değildir. `disabled` özniteliği tıklamayı
tarayıcıda yutar; burada yerine `aria-disabled` kullanılır: buton görünürde
gri kalır, odaklanabilir kalır ve basıldığında işleyicisi tam gerekçesini
yazar. Eyleme hazır olmayan her kontrol cevap verir, hiçbir tıklama sessiz
kalmaz (1.0 konsolunda `tools/check-live-actions.js` aynı sözleşmeyi 32
kontrolde doğrular).

Düzeltmeler bu sözleşmenin ürünüdür: `stamp(owner)` argümansız çağrıldığında
VM `MismatchingParameterLen` ile reddediyordu (damga butonu hiç çalışmadı);
1.0 burn akışı tanımsız `recipient` değişkeni ve tarayıcıda var olmayan
`Buffer` yüzünden ilk ağ çağrısından önce çöküyordu.
