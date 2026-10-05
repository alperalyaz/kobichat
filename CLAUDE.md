# KobiChat — Proje Rehberi (yeni oturum için)

> Kullanıcı Türkçe konuşur, hızlı iterasyon yapar, her değişikliği commit + `bekleyen/<konu>` dalına push bekler.

## 🔴 DEPLOY YALNIZ KULLANICI "DEPLOY" DEYİNCE — İSTİSNA YOK (kullanıcı kararı 2026-10-01)

Kullanıcı: *"sayfa patlasa da çatlasa da ben deploy demeden deploy yapmasın."* Kullanıcının bütün projelerinde geçerli.

- **Deploy** = canlıya kod çıkaran her işlem: canlı dala push, Vercel'de yeniden yayın / öne alma (promote) /
  **geri alma (rollback)**, Supabase Edge Function deploy, Apps Script'e kod gönderme.
- **Canlı kırık olsa da istisna YOK.** "Acil", "daha önce çalışıyordu", "tek satırlık düzeltme" gerekçe değildir.
- **Bir "deploy" = bir yayın.** Yayından sonra çıkan hata için kullanıcıya YENİDEN sorulur. Başka oturumda verilen
  "deploy" bu oturuma izin değildir.
- **Canlı kırıksa boş durma:** düzelt, dene, `bekleyen/<konu>` dalına koy, kullanıcıya TEK mesaj yaz:
  `🔴 CANLI KIRIK: <ne bozuk> — <kimi etkiliyor> — düzeltme hazır (<dal>) — "deploy" dersen canlıya çıkar.`
- **"Deploy edeyim mi?" diye ısrar etme.** İş bitince bittiğini söyle ve bekle; yayını kullanıcı ister.
- **Kullanıcıya görev verme.** Betikle, MCP ile ya da tarayıcı ajanına verilecek hazır talimatla yapılabilen işi
  kendin yap; kullanıcıdan yalnız onun yapabileceğini iste (2FA, şifre, ödeme onayı, karar).
- Veritabanı işleri (migration, veri düzeltme) bu kuralın konusu değil; onların kendi kuralları geçerli.

## 🗂️ BEKLEYEN DAL — biten iş burada birikir (kullanıcı kararı 2026-10-02)

Kullanıcı: *"bekleyen diye dal yapsın, tüm repolar commitleri orada biriktirsin; ben demeden asla deploy istemiyorum."*

- Biten ve denenmiş iş **`bekleyen/<konu>`** dalına itilir: `git push origin HEAD:bekleyen/<konu>`.
  Dal, canlı dalın GÜNCEL hâlinden kurulur (`git fetch origin <canlı dal>`), GitHub varsayılan dalından değil.
  Her iş KENDİ dalında — aynı anda çalışan oturumlar birbirinin işini ezmesin. Yarım iş konmaz:
  bekleyen dal "hazır, deploy bekliyor" demektir. Aynı dalı güncellerken üstüne yeni commit ekle; düz
  `bekleyen` adlı dal AÇMA (`bekleyen/*` ile çakışır).
- Kendi `claude/...` dalına yedek push serbest. Canlı dala push YOK.
- **Kullanıcı "deploy" deyince:**
  1. Listele: `git ls-remote --heads origin 'refs/heads/bekleyen/*'` — düz `git fetch origin` YETMEZ:
     bulut oturumu repoyu tek dallı klonlar, başka oturumların `bekleyen/*` dallarını hiç görmez.
  2. Getir: `git fetch origin '+refs/heads/bekleyen/*:refs/remotes/origin/bekleyen/*'`
     (sığ klonda birleştirme taban bulamazsa önce `git fetch --unshallow origin`).
  3. Listeyi kullanıcıya göster → canlı dala birleştir → derle/dene → **TEK** push → yayının gerçekten
     oluştuğunu doğrula → birleşen dalları sil (bulut oturumunda silme 403 verirse bırak, zararsız).

## Bu projede yayın nasıl oluşur

- Canlı dal **`main`**: `main`'e push → GitHub Actions `build-win.yml` → Release `vX.Y.Z` (ayrıntı aşağıda "Sürüm / yayın").
- Bu projede kullanıcının **"release al" / "yayınla"** demesi **"deploy"** demektir. Bu söz yoksa `main`'e push da
  sürüm yükseltme de YOK; biten iş `bekleyen/<konu>` dalında bekler.

## ⚠️ EN ÖNEMLİ KURAL: Kullanıcıya iş yükleme
Kullanıcı "şunu yap, bunu çalıştır, şu adımları izle" tarzı görev listeleri **istemiyor**.
Bir iş betikle, otomasyonla, tarayıcı ajanına verilecek talimatla ya da senin tarafından
yapılabiliyorsa **öyle yap**; kullanıcıya emir verir gibi adım adım görev verme.
- **Kullanıcının makinesinde iş gerekiyorsa:** tek çift tıkla çalışan, kendi kendine yeten bir
  betik hazırla ve dosyayı gönder. Betik yönetici iznini kendisi istesin, gereken bilgiyi
  kendisi bulsun, yedek alsın, sonucu doğrulasın, başarısızsa geri alsın.
  Örnek: `KobiChat-Sunucu-Guncelle.cmd` (`scripts/make-server-updater.cjs`).
- **Bir web panelinde iş gerekiyorsa** (Partner Center, GitHub ayarları vb.): tarayıcıdaki
  ajana yapıştırılacak hazır talimat metni yaz.
- **Teşhiste de** önce kendin bak (kod, günlükler, test ortamı); kullanıcıdan çıktı istemek son çare.
- Kullanıcıya doğrudan görev **ancak başka yol yoksa** verilir (yalnızca onun bildiği şifre,
  fiziksel erişim vb.). O zaman da en kısa hâliyle: tek adım + ne görmesi gerektiği.

## ⚠️ Yayından önce onay
Kullanıcıya görünen her değişiklikte **yayınlamadan önce ekran görüntüsü (gerekirse hareketli GIF)
gönder, onayını bekle**.
- **Sürüm yükseltip `main`'e göndermek yalnızca kullanıcı açıkça "yayınla / release al" dediğinde.**
  Bir tasarımı beğenmesi ya da bir seçeneği seçmesi ("14 yap", "tamam güzel") yayın onayı DEĞİLDİR;
  değişikliği `bekleyen/<konu>` dalına it, "yayınlayayım mı?" diye sor. Kullanıcı çoğu zaman birkaç işi
  tek sürümde toplamak ister.
Görüntüleri bu ortamda gerçek uygulamadan çek (aşağıdaki "Doğrulama"); kullanıcıdan
`npm run` vb. çalıştırmasını isteme.

## Ne bu proje?
Şirket içi (Hidroteknik) **yerel ağ sohbet uygulaması + bilgi panosu**. İnternet gerektirmez.
Electron masaüstü uygulaması; içinde Express + Socket.IO + SQLite (sql.js) sunucusu var.
**Pano** (KobiTools'tan taşındı): duyurular, günün menüsü, döviz kurları (varsayılan kapalı,
isteğe bağlı otomatik), uygulama kısayolları, zamanlı bildirimler, şok bildirim.

## Yığın / dosyalar
- `electron/main.cjs` (pencereler, tepsi, IPC, şok/zamanlı bildirim pencereleri, Pano çekmecesi
  animasyonu `setMainWindowMode`), `electron/preload.cjs` (`window.kobiChat`).
- `server/chat-server.cjs` (sohbet sunucusu), `server/board.cjs` (Pano: `board_kv` tablosu,
  `board:get/set/shock` olayları, kur çekme, zamanlı bildirim zamanlayıcısı).
- `src/App.jsx` (kişi listesi penceresi + solundaki **PANO** tutamağı),
  `src/board/BoardDrawerApp.jsx` (sustalı çekmece: listenin solunda ayrı, çerçevesiz, şeffaf
  pencere; liste penceresi hiç kıpırdamaz, içerik CSS `transform` ile kayar; solda yer yoksa sağdan
  açılır; ana süreçte `openBoardDrawer`/`closeBoardDrawer`),
  `src/ChatApp.jsx` (sohbet penceresi), `src/board/` (Pano arayüzü).
- i18n: `src/i18n/messages.js` + `src/i18n/boardMessages.js`; 5 dil (tr/en/de/fr/es).
  **Anahtar paritesi korunmalı**, görünen her metin i18n'den geçmeli.

## Pano yetkisi
Pano yalnızca **sunucuyu çalıştıran bilgisayardan** düzenlenir: soketin adresi loopback ya da
makinenin kendi IP'lerinden biriyse `canEdit`. Ek şifre yok (kullanıcının kararı).

## ⚠️ Şirketteki gerçek sunucu kurulumu
- Sunucu makinesi **192.168.1.66**. Sunucu, uygulamadan **ayrı** olarak `C:\KobiChat` klasöründen
  `node server\chat-server.cjs` ile çalışıyor (veri: `C:\KobiChat\data`).
- O makinedeki KobiChat uygulaması "uzak sunucu 127.0.0.1" modunda bu sunucuya bağlanıyor.
  Bu doğru; "Bu bilgisayarda sunucu çalışsın" seçilmemeli (port çakışır).
- **Uygulama güncellemesi bu ayrı sunucuyu güncellemez.** Sunucu kodu (`server/`) değişen her
  sürümden sonra sunucuda `KobiChat-Sunucu-Guncelle.cmd` çalıştırılmalı (her GitHub Release'inde
  hazır gelir; yoksa `node scripts/make-server-updater.cjs <klasör>` ile üret ve dosyayı gönder).
- Sunucu sürümünü doğrulamak: `http://<sunucu>:3847/api/server-meta` → `version`.
- İstemci, Pano'yu bilmeyen eski bir sunucuya bağlanırsa "Sunucu Pano'yu henüz desteklemiyor" der.

## Sürüm / yayın
- Sürüm yalnızca `package.json`'da: `npm version X.Y.Z --no-git-tag-version`.
- `main` canlıdır: `main`'e push → GitHub Actions `build-win.yml` → Release `vX.Y.Z`
  (.exe + latest.yml ile otomatik güncelleme, .appx, sunucu güncelleyici .cmd).
  `.md` değişiklikleri derleme tetiklemez.
- Store için .appx'i kullanıcı Partner Center'a yükler.
- Biten iş `bekleyen/<konu>` dallarında birikir (`feature/pano` eski çalışma dalıdır). Kullanıcı "release al /
  yayınla" (= deploy) deyince bekleyen dalları `main`'e birleştir, sürümü yükselt, **TEK** push et.

## Doğrulama
- Her değişiklikten sonra `npx vite build`; `node --check electron/main.cjs`.
- `electron/main.cjs` / `preload.cjs` değişirse uygulama tamamen kapatılıp açılmalı.
- Gerçek uygulama testi bu ortamda mümkün: Electron 22 + Xvfb (`DISPLAY=:99`,
  `--no-sandbox --remote-debugging-port=9333`), DevTools protokolüyle tıklama/ölçüm,
  ekran görüntüsü için Pillow `ImageGrab.grab(xdisplay=':99')`. Playwright `connectOverCDP`
  Electron 22'de çalışmıyor; ham CDP (WebSocket) kullan.
- `pkill -f`/`pgrep -f` kullanma: kendi kabuk komutunu da eşleyip oturumu öldürüyor.
- Geliştirme modunda her pencere DevTools açar; çekimden önce `http://127.0.0.1:9333/json/close/<id>`
  ile kapat. Ana süreç için `--inspect=9229` + `process.mainModule.require('electron')`.
- Bu ortamda internet trafiği ara sunucudan geçer; Electron içindeki sunucu kur çekemez
  ("self signed certificate"). Kur görüntüsü için sunucuyu ayrı `node` süreci olarak çalıştır
  (şirketteki kurulumla aynı). Xvfb şeffaflık desteklemez; şeffaf pencereler siyah görünür.

## Kısıtlar / tercihler
- Sade, güvenli, gereksiz soyutlama olmayan kod. Gereksiz emoji/yorum yok.
- Commit mesajları Türkçe.
- Yıkıcı git işlemleri (force push, reset --hard) izinsiz yapılmaz.
- Gizli/sessiz izleme yok; her şey rızaya dayalı.
