# CLAUDE.md

Claude Code (claude.ai/code) için bu repo rehberi.

## 🔍 PLAN ELEŞTİRİSİ (otomatik) — kod yazmadan önce

Çok adımlı, mimari veya geri-alınamaz bir plan/yaklaşım önerdikten SONRA, uygulamaya
(kod/komut/migration/deploy) geçmeden ÖNCE `plan-elestirmen` alt-ajanını çağır; planı ona
**parçalat**, bulgularını kullanıcıya ilet, sonra ilerle. Ajan tanımı `.claude/agents/plan-elestirmen.md`.
Önemsiz/tek-satırlık işlerde GEREKMEZ (token/zaman israfı). Amaç: kıdemli-şüpheci ikinci göz —
atlanan kenar durumlar, yarış koşulları, sıralama hataları erken yakalansın.
