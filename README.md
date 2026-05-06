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

Bu makinede GitHub CLI ile oturum açın:

```bash
gh auth login
```

Ardından boş bir repo oluşturup gönderin (örnek repo adı `kobichat`):

```bash
gh repo create kobichat --private --source=. --remote=origin --push
```

Veya GitHub web arayüzünden boş repo oluşturduktan sonra:

```bash
git remote add origin https://github.com/KULLANICI/kobichat.git
git branch -M main
git push -u origin main
```

**Not:** İlk commit öncesi `git config user.name` ve `git config user.email` değerlerini kendi bilgilerinizle güncellemek isterseniz:

```bash
git config user.name "Adınız"
git config user.email "email@ornek.com"
```
