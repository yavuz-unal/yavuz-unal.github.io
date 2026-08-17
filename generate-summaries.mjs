// ============================================================
//  Türkçe özet üretici — onaylı yayınların abstract'ından
//  Gemini API ile özgün Türkçe paragraf üretir, Supabase'e yazar.
//  Node 18+ (yerleşik fetch, ek paket YOK). GitHub Actions'ta çalışır.
//
//  Gerekli ortam değişkenleri:
//    GEMINI_API_KEY          — Google AI Studio'dan
//    SUPABASE_SERVICE_KEY    — Supabase → Settings → API Keys → sb_secret_...
// ============================================================

const SUPABASE_URL = 'https://epxdfwryvlpolmjyqfgb.supabase.co';
const TABLE        = 'publications';

// DİKKAT: Gemini model adları sık değişiyor. 404 hatası alırsan
// Actions logundaki hata mesajı yeni model adını söyler, buraya yaz.
const MODEL = 'gemini-3.6-flash';

// Ücretsiz kuota koruması
const RUN_LIMIT   = 25;    // tek çalıştırmada en fazla kaç yayın
const DELAY_MS    = 7000;  // istekler arası bekleme (dakikada ~8 istek)
const MAX_RETRY   = 4;

const GEMINI_KEY   = process.env.GEMINI_API_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

if (!GEMINI_KEY || !SERVICE_KEY) {
  console.error('HATA: GEMINI_API_KEY ve SUPABASE_SERVICE_KEY tanımlı olmalı.');
  process.exit(1);
}

// ==================== PROMPT ====================
const SYSTEM_PROMPT = `Sen bir akademik yayın dizini için Türkçe tanıtım özetleri yazıyorsun.
Sana bir makalenin başlığı ve İngilizce özeti (abstract) verilecek.

Görevin: tek paragraf, 120-180 kelime Türkçe metin yazmak.

Kurallar:
- ÇEVİRİ YAPMA. Cümleleri birebir aktarma. Metni oku, anla, kendi
  cümlelerinle ve farklı bir kurguyla yeniden anlat.
- Sadece verilen özette geçen bilgiyi kullan. Hiçbir bulgu, sayı veya
  iddia ekleme. Özette yoksa yazma.
- Yöntem adlarını, model adlarını ve kısaltmaları olduğu gibi koru
  (ör. FCMAE V2-WPAT, ConvNeXt V2, CBAM, ResNet-50). Bunları Türkçeleştirme.
- Övgü dili kullanma: "çığır açan", "önemli bir katkı", "dikkat çekici",
  "kapsamlı bir şekilde" gibi ifadeler yasak. Nötr ve betimleyici yaz.
- Ağır edilgen yapıdan kaçın. "Gerçekleştirilmiştir", "sağlanmaktadır"
  yerine daha doğrudan kurulumlar tercih et.
- Şu sırayı takip et: çalışma neyi ele alıyor → hangi yöntemi kullanıyor
  → ne sonuç elde ediyor.
- Metnin içinde "bu çalışmada" ifadesini en fazla bir kez kullan.
- Yalnızca paragrafı döndür. Başlık, giriş cümlesi, madde işareti,
  markdown, tırnak işareti kullanma.`;

// ==================== YARDIMCILAR ====================
const bekle = ms => new Promise(r => setTimeout(r, ms));

function jatsTemizle(ham) {
  if (!ham) return null;
  const s = String(ham)
    .replace(/<jats:title[^>]*>.*?<\/jats:title>/gis, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 80 ? s : null;
}

function kelimeSayisi(s) {
  return String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
}

// Üretilen metin işe yarar mı?
function gecerliMi(metin, abstract) {
  if (!metin) return 'boş yanıt';
  const kn = kelimeSayisi(metin);
  if (kn < 60)  return `çok kısa (${kn} kelime)`;
  if (kn > 280) return `çok uzun (${kn} kelime)`;
  if (/^#|^\*|^-\s|```/m.test(metin)) return 'markdown içeriyor';
  // Modelin abstract'tan uzun bir cümleyi aynen kopyalamadığını kontrol et
  const ilk = abstract.slice(0, 120).toLowerCase();
  if (metin.toLowerCase().includes(ilk)) return 'abstract kopyalanmış';
  return null;
}

// ==================== SUPABASE ====================
const sbBaslik = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function bekleyenleriGetir() {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}`
    + `?status=eq.approved`
    + `&abstract=not.is.null`
    + `&summary_tr=is.null`
    + `&select=id,title,abstract`
    + `&limit=${RUN_LIMIT}`;
  const res = await fetch(url, { headers: sbBaslik });
  if (!res.ok) throw new Error(`Supabase okuma hatası ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ozetKaydet(id, ozet) {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...sbBaslik, Prefer: 'return=minimal' },
    body: JSON.stringify({ summary_tr: ozet, summary_generated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase yazma hatası ${res.status}: ${await res.text()}`);
}

// ==================== GEMINI ====================
async function ozetUret(baslik, abstract) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [{ text: `Başlık: ${baslik}\n\nÖzet (abstract):\n${abstract}` }],
    }],
    generationConfig: {
      temperature: 0.4,
      // DİKKAT: Gemini 3'te bu bütçe düşünme + çıktı TOPLAMI için geçerli.
      // Düşük tutarsan model çıktıyı cümle ortasında keser.
      maxOutputTokens: 4000,
      // Gemini 3 sayısal thinkingBudget'ı yok sayar, thinkingLevel kullanır.
      thinkingConfig: { thinkingLevel: 'low' },
    },
  };

  for (let deneme = 0; deneme < MAX_RETRY; deneme++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify(body),
    });

    if (res.status === 429 || res.status >= 500) {
      const geri = Math.min(60, 2 ** (deneme + 3)) * 1000;
      console.log(`   ↻ ${res.status} — ${geri / 1000}s sonra tekrar`);
      await bekle(geri);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const veri = await res.json();
    const aday  = veri?.candidates?.[0];
    const neden = aday?.finishReason;

    if (neden && neden !== 'STOP') {
      const kul = veri?.usageMetadata ?? {};
      console.log(`   ⚠ finishReason: ${neden}`
        + ` (düşünme: ${kul.thoughtsTokenCount ?? '?'},`
        + ` çıktı: ${kul.candidatesTokenCount ?? '?'} token)`);
    }

    const metin = aday?.content?.parts?.map(p => p.text ?? '').join('').trim();
    return (metin || '').replace(/^["'`]+|["'`]+$/g, '').trim();
  }
  throw new Error('Gemini: tekrar denemeler tükendi');
}

// ==================== ANA AKIŞ ====================
async function main() {
  const kayitlar = await bekleyenleriGetir();
  if (!kayitlar.length) {
    console.log('Özet bekleyen yayın yok. Çıkılıyor.');
    return;
  }
  console.log(`${kayitlar.length} yayın işlenecek.\n`);

  let basarili = 0, atlanan = 0, hatali = 0;

  for (const [i, p] of kayitlar.entries()) {
    const kisa = String(p.title ?? '').slice(0, 60);
    console.log(`[${i + 1}/${kayitlar.length}] ${kisa}…`);

    const abstract = jatsTemizle(p.abstract);
    if (!abstract) {
      console.log('   ⨯ abstract kullanılabilir değil, atlandı');
      atlanan++;
      continue;
    }

    try {
      const ozet = await ozetUret(p.title ?? '', abstract);
      const sorun = gecerliMi(ozet, abstract);
      if (sorun) {
        console.log(`   ⨯ reddedildi: ${sorun}`);
        atlanan++;
      } else {
        await ozetKaydet(p.id, ozet);
        console.log(`   ✓ ${kelimeSayisi(ozet)} kelime kaydedildi`);
        basarili++;
      }
    } catch (err) {
      console.log(`   ! hata: ${err.message}`);
      hatali++;
    }

    if (i < kayitlar.length - 1) await bekle(DELAY_MS);
  }

  console.log(`\nBitti — ${basarili} kaydedildi, ${atlanan} atlandı, ${hatali} hata.`);
}

main().catch(err => { console.error('ÖLÜMCÜL:', err); process.exit(1); });
