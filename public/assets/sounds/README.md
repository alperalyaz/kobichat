# KobiChat — Ses Dosyası Rehberi

Bu klasördeki sesler `src/sounds.js` modülü tarafından çalınır. Her dosya
belirli bir uygulama olayına bağlıdır. Tek tek dinlemek zorunda kalmadan
hangi sesin nerede çıktığını aşağıdaki tablodan kontrol edebilirsin.

> Settings → **Bildirim** kartından kategori bazlı (Mesaj / Dosya / Sistem /
> Kişi durumu) açıp kapatabilir, master ses seviyesini değiştirebilirsin.

---

## Olay → Ses dosyası eşlemesi

| # | Dosya | Olay (kod adı) | Ne zaman çalar? | Kategori | Volüm | Throttle |
|---|---|---|---|---|---|---|
| 1 | `1.mp3` | `messageIncomingAlert` | DM geldi ve **sohbet penceresi KAPALI** | message | 0.90 | 250 ms |
| 2 | `2.mp3` | `messageIncomingSoft` | DM geldi ve **sohbet penceresi AÇIK** | message | 0.45 | 200 ms |
| 3 | `3.mp3` | `messageSent` | Kendi mesajını gönderdiğinde | message | 0.32 | 200 ms |
| 4 | `4.mp3` | `fileIncoming` | Dosya/ek geldi (sohbet penceresi kapalıyken) | file | 0.75 | 400 ms |
| 5 | `5.mp3` | `fileSent` | Dosya/ek başarıyla gönderildi | file | 0.40 | 300 ms |
| 6 | `6.mp3` | `downloadComplete` | Karşıdan gelen dosya indirildi (Documents/kobiChat) | file | 0.60 | 400 ms |
| 7 | `7.mp3` | `connected` | Sunucuya bağlanıldı (uygulama açıldığında ya da kopuk → bağlı geçişinde) | system | 0.55 | 1500 ms |
| 8 | `8.mp3` | `disconnected` | Sunucuyla bağlantı koptu (bağlı → kopuk geçişinde) | system | 0.50 | 1500 ms |
| 9 | `9.mp3` | `reconnectFailed` | Yeniden bağlanma denemesi başarısız (`connect_error`) | system | 0.60 | 5000 ms |
| 10 | `10.mp3` | `userOnline` | Roster'dan biri online oldu (kendi haricinde) | presence | 0.32 | 1500 ms |
| 11 | `11.mp3` | `userOffline` | Roster'dan biri offline oldu | presence | 0.28 | 1500 ms |
| 14 | `14.mp3` | `error` | Mesaj/dosya gönderilemedi, indirme başarısız, sunucu hatası | system | 0.70 | 600 ms |

---

## Açıklamalar

### Volüm
Her sesin **kendi sabit volümü** (yukarıdaki tablo) ile ayarlardaki
**master volume** (varsayılan 0.85) çarpılır. Yani 0.90 × 0.85 ≈ 0.77 son
ses seviyesi olur. Master volume slider'ından canlı değiştirebilirsin.

### Throttle
Aynı sesin art arda hızlı tetiklenmesini önler.
- Mesaj sesleri 200–400 ms (10 kişi aynı anda yazsa bile sağlık çıkmaz).
- Presence sesleri 1500 ms (5 kişi aynı anda online olursa tek "ping").
- `reconnectFailed` ve `updateAvailable` 5000 ms (sürekli denemede spam yapmaz).

### Kategoriler ve varsayılanlar
| Kategori | Varsayılan | Açıklama |
|---|---|---|
| `message` | **AÇIK** | Tüm mesaj sesleri (gelen + giden) |
| `file` | **AÇIK** | Dosya gelen/giden + indirme tamamlandı |
| `system` | **AÇIK** | Bağlantı, hata, güncelleme sesleri |
| `presence` | **KAPALI** | Online/offline sesleri (kalabalık ofiste gürültücü olur) |

### Pencere açık/kapalı ayrımı
Aynı kişiyle açık bir sohbet penceresi varsa "yumuşak" ses (`2.mp3`) çalar;
yoksa "alarm" sesi (`1.mp3`) çalar ve kişi kenar çubuğunda **okunmamış** olarak
işaretlenir. Bu sayede aynı mesaj için iki ses üst üste çalmaz.

### Kendi durumun
Roster'da senin kendi online/offline durumun **ses çıkarmaz** — sadece
diğer kişiler için tetiklenir. İlk roster geldiğinde de baseline kurulup
sesli bildirim atlanır (uygulama yeni açılmış olabilir).

---

## Eksik dosyalar (şu an kullanılmıyor)

Aşağıdaki numaralar sözlükte yer alıyordu ama dosya yok ve hâlâ kullanılmıyor:

- `12.mp3` — kişi durum değiştirdi (meşgul/dışarıda) → şu an gereksiz
  bulunduğundan event yok.
- `13.mp3` — emoji reaksiyon geldi → reaksiyon özelliği yok.
- `15.mp3` — quick message gönderildi → şu an `messageSent` (3.mp3) çalıyor.
- `17.mp3` — mention/etiketleme → bu özellik henüz yok.

Bu olaylar eklenmek istenirse `src/sounds.js` içindeki `SOUNDS` map'ine bir
satır eklemek + uygun event'e `playSound("…")` çağrısı koymak yeterli.

---

## Bir sesi değiştirmek istersen

1. Yeni `.mp3` dosyasını **aynı isimle** (örn. `1.mp3`) bu klasöre koy.
2. Geliştirme modunda (`npm run dev`) ana pencereyi yenile (Ctrl+R).
3. Üretim build'inde (`npm run build`) yeni dosya `dist/web/assets/sounds/`'a
   otomatik kopyalanır.

Volümü değiştirmek için: `src/sounds.js` içindeki `SOUNDS` map'inde
ilgili sesin `volume` alanını düzenle (0..1 arası).

Throttle'ı değiştirmek için aynı dosyada `throttleMs` alanını güncelle.
