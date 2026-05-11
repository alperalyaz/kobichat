# KobiChat

Yerel ağ (LAN) üzerinde çalışan masaüstü sohbet ve dosya paylaşım uygulaması. Electron + React (Vite) istemci, Express + Socket.IO + SQLite (`sql.js`) sunucu.

## Gereksinimler

- Node.js 18+ (önerilir)
- Windows için kurulum: `npm run setup` (NSIS installer üretir)

## Geliştirme

```bash
npm install
npm run dev
```

## Üretim derlemesi

```bash
npm run build
npm run setup
```

Kurulum çıktısı `release/` altında oluşur; bu klasör Git’e dahil edilmez.

## GitHub’a ilk yükleme

Bu makinede GitHub CLI ile oturum açın (etkileşimli; tarayıcı veya token seçebilirsiniz):

```bash
gh auth login
```

Ardından bu klasörde boş bir repo oluşturup gönderin (`kobichat` adı doluysa başka bir ad verin):

```bash
cd d:\Hidroteknik\kobichat
gh repo create kobichat --public --source=. --remote=origin --push
```

Özel repo için `--private` kullanın. Otomasyon için ortam değişkeni `GH_TOKEN` (klasik PAT, `repo` izni) da kullanılabilir.

Veya GitHub web arayüzünden boş repo oluşturduktan sonra:

```bash
git remote add origin https://github.com/KULLANICI/kobichat.git
git branch -M main
git push -u origin main
```

**Not:** Yerel commit yazarı şu an `Hidroteknik` / `noreply@example.com`. Kendi adınız ve GitHub e-postanızla değiştirmek için (yalnızca bu repo):

```bash
git config user.name "Adınız"
git config user.email "sizin@email.com"
```

Son commit mesajını değiştirmeden yazarı güncellemek için: `git commit --amend --reset-author --no-edit`
