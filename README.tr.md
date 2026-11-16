# KobiChat

🇬🇧 [English](README.md) · 🇹🇷 Türkçe

**Yerel ağınızdan dışarı çıkmayan ofis içi sohbet ve dosya paylaşımı.**

Ofisteki bir bilgisayar sunucu olur, diğerleri ona bağlanır, hiçbir şey internetten
geçmez. Hesap yok, bulut yok, abonelik yok. Mesajlar ve dosyalar sizin bilgisayarınızda
durur.

Denizli'de hidrolik ve pnömatik işi yapan [Hidroteknik](https://www.hidroteknik.com.tr)
için geliştirildi ve orada her gün kullanılıyor.

**İndir:** [Microsoft Store](https://apps.microsoft.com/detail/9N01GLSS1KBJ) ·
[Windows kurulum dosyası](https://github.com/alperalyaz/kobichat/releases/latest)

## Ne yapar

**Sohbet**

- Her biri kendi penceresinde birebir sohbet, "yazıyor" ve "okundu" göstergeleri
- Sürükle bırak ile dosya paylaşımı, dosya başına 80 MB'a kadar
- Çevrimdışı kişilere yazılan mesajlar sunucuda bekler, kişi bağlanınca iletilir
- Toplu mesaj: Ctrl ile birkaç kişiyi seçip hepsine birden yazma
- Durum (Müsait, Meşgul, Dışarıda) ve dikkat çekmek için "titreşim"
- Ctrl+1 ile Ctrl+7 arası hızlı mesajlar, mesaj arama, sohbet geçmişi
- Açık ve koyu tema, profil resmi, türüne göre bildirim sesleri
- Türkçe, İngilizce, Almanca, Fransızca ve İspanyolca

**Pano**

Kişi listesinin yanında açılan, bütün ofisin gördüğü çekmece:

- Duyurular ve notlar
- Günün yemeği, aylık liste olarak yüklenir
- Döviz kurları (varsayılan kapalı, internet kullanan tek özellik budur)
- Ekibin kullandığı uygulama ve bağlantılara kısayollar
- Mesai saati, doğum günü, kutlama gibi zamanlı bildirimler
- Açık olan bütün bilgisayarlarda tam ekran, kırmızı ve sesli gösterilen acil duyuru

Pano yalnızca sunucuyu çalıştıran bilgisayardan düzenlenir.

## Kurulum

1. KobiChat'i bütün bilgisayarlara kurun.
2. Sunucu olacak bilgisayarda Ayarlar'ı açıp **Bu bilgisayarda sunucu çalışsın**
   seçeneğini işaretleyin. Bu bilgisayar mesai boyunca açık kalmalı.
3. Diğer bilgisayarlarda **Uzak sunucuya bağlan** seçeneğini işaretleyip sunucunun IP
   adresini girin, örneğin `192.168.1.10`.

Sunucu TCP 3847 portunu dinler. Kurulum, Windows Güvenlik Duvarı'na bu port için kural
eklemeyi dener. Diğer bilgisayarlar bağlanamıyorsa porta elle izin verin.

Sunucu verisi (mesajlar ve dosyalar) `%AppData%\kobichat\server-data` klasöründedir.
Sunucuyu başka bir bilgisayara taşımak için uygulamayı kapatıp bu klasörü kopyalayın.

Varsayılan olarak metin mesajları 90 gün, dosyalar 7 gün saklanır. Bu süreler ve diğer
sınırlar ortam değişkenleriyle değiştirilebilir; liste
[ENV_RELEASE.example.txt](ENV_RELEASE.example.txt) dosyasında.

### Sunucuyu tek başına çalıştırmak

Sunucu, masaüstü uygulaması olmadan da çalışır. Sürekli açık duran bir makine için
uygundur:

```bash
npm install
npm start
```

Bir sunucunun hangi sürümde olduğunu `http://<sunucu>:3847/api/server-meta` adresinden
görebilirsiniz. Tek başına çalışan sunucuyu uygulama güncellemez. Her
[sürümde](https://github.com/alperalyaz/kobichat/releases) gelen
`KobiChat-Sunucu-Guncelle.cmd` dosyası sunucuyu yerinde günceller.

## Güvenmeden önce bilmeniz gerekenler

- **Ağınıza güvenir.** Şifre yoktur. Herkes bir görünen ad seçer ve yerel ağda sunucuya
  erişebilen herkes katılabilir. Trafik düz HTTP'dir, şifrelenmez. Kendi denetiminizdeki
  bir ofis ağında kullanın ve 3847 portunu internete açmayın.
- **Yalnızca Windows**, 64 bit. Store sürümü Windows 10 veya 11 ister.
- **Kurulum dosyası kod imzalı değildir**, bu yüzden Windows SmartScreen ilk çalıştırmada
  uyarı verir. Microsoft Store sürümünde bu sorun yoktur.
- **Güncellemeler Microsoft Store üzerinden gelir.** Kurulum dosyasıyla kurulan sürüm
  kendini güncellemez.
- **Tek sunucu.** Yedek sunucu yoktur: sunucu bilgisayarı kapalıysa sohbet de kapalıdır.

## Geliştirme

[Node.js](https://nodejs.org) 18 veya üstü gerekir.

```bash
npm install
npm run dev      # Vite + Electron, anında yenileme ile
npm run setup    # Windows kurulum dosyasını release/ klasörüne üretir
```

Sunucu için hızlı testler:

```bash
npm run test:single-server   # çevrimdışı kuyruk ve yeniden iletim
npm run test:history         # mesaj sıralaması
npm run test:cluster         # kalıcı kayıt ve tekrar eden isteklerin tek sayılması
```

## Nasıl yapıldı

| Parça | Teknoloji |
|---|---|
| Masaüstü uygulaması | Electron 22, React, Vite |
| Sunucu | Express, Socket.IO |
| Depolama | `sql.js` ile SQLite, dosyalar diskte |
| Paketleme | electron-builder (NSIS kurulum ve Microsoft Store `.appx`) |

`electron/` ana süreci, `server/` sohbet sunucusunu ve panoyu, `src/` arayüzü içerir.
`main` dalına yapılan gönderim, GitHub Actions üzerinden sürümü derleyip yayınlar.

---

[Hidroteknik](https://www.hidroteknik.com.tr) için Alper Alyaz tarafından geliştirildi.
