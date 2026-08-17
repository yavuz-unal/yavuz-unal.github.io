// ============================================================
//  Abstract doldurucu — mevcut kayıtların DOI'sinden Crossref'e
//  sorup abstract alanını doldurur. Tek seferlik / ara sıra çalışır.
//  Node 18+ (yerleşik fetch, ek paket YOK).
//
//  Gerekli ortam değişkeni:
//    SUPABASE_SERVICE_KEY   — Supabase → Settings → API Keys → sb_secret_...
//
//  Not: Crossref abstract'ı ZORUNLU alan değil. Yayıncı yatırmadıysa
//  gelmez. Script sonunda boş kalanların listesini yazdırır; onları
//  Supabase panelinden elle yapıştırırsın.
// ============================================================

const SUPABASE_URL = 'https://epxdfwryvlpolmjyqfgb.supabase.co';
const TABLE        = 'publications';

// Crossref "polite pool" — kendi e-postanı yaz, istekler önceliklendirilir.
const MAILTO = 'yavuzunal@sinop.edu.tr';

const DELAY_MS  = 1200;   // Crossref'e nazik davran
const RUN_LIMIT = 200;

const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SERVICE_KEY) {
  console.error('HATA: SUPABASE_SERVICE_KEY tanımlı olmalı.');
  process.exit(1);
}

const bekle = ms => new Promise(r => setTimeout(r, ms));

// ==================== JATS TEMİZLEYİCİ ====================
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

function doiSadelestir(ham) {
  return String(ham ?? '')
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
}

// ==================== SUPABASE ====================
const sbBaslik = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function eksikleriGetir() {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}`
    + `?abstract=is.null`
    + `&doi=not.is.null`
    + `&select=id,title,doi`
    + `&limit=${RUN_LIMIT}`;
  const res = await fetch(url, { headers: sbBaslik });
  if (!res.ok) throw new Error(`Supabase okuma hatası ${res.status}: ${await res.text()}`);
  return res.json();
}

async function abstractKaydet(id, abstract) {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...sbBaslik, Prefer: 'return=minimal' },
    body: JSON.stringify({ abstract }),
  });
  if (!res.ok) throw new Error(`Supabase yazma hatası ${res.status}: ${await res.text()}`);
}

// ==================== CROSSREF ====================
async function crossrefAbstract(doi) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`
    + `?mailto=${encodeURIComponent(MAILTO)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': `akademik-yayin-dizini/1.0 (mailto:${MAILTO})` },
  });

  if (res.status === 404) return { durum: 'doi-yok' };
  if (!res.ok) return { durum: `http-${res.status}` };

  const veri = await res.json();
  const temiz = jatsTemizle(veri?.message?.abstract);
  return temiz ? { durum: 'var', abstract: temiz } : { durum: 'abstract-yok' };
}

// ==================== ANA AKIŞ ====================
async function main() {
  const kayitlar = await eksikleriGetir();
  if (!kayitlar.length) {
    console.log('Abstract eksik kayıt yok. Çıkılıyor.');
    return;
  }
  console.log(`${kayitlar.length} kayıt kontrol edilecek.\n`);

  let dolduruldu = 0;
  const bosKalanlar = [];

  for (const [i, p] of kayitlar.entries()) {
    const doi  = doiSadelestir(p.doi);
    const kisa = String(p.title ?? '').slice(0, 55);
    console.log(`[${i + 1}/${kayitlar.length}] ${kisa}…`);

    if (!doi) {
      console.log('   ⨯ DOI okunamadı');
      bosKalanlar.push({ ...p, sebep: 'DOI geçersiz' });
    } else {
      try {
        const sonuc = await crossrefAbstract(doi);
        if (sonuc.durum === 'var') {
          await abstractKaydet(p.id, sonuc.abstract);
          const kn = sonuc.abstract.split(/\s+/).length;
          console.log(`   ✓ ${kn} kelimelik abstract kaydedildi`);
          dolduruldu++;
        } else {
          const mesaj = {
            'abstract-yok': 'Crossref\'te abstract yok (yayıncı yatırmamış)',
            'doi-yok':      'DOI Crossref\'te bulunamadı',
          }[sonuc.durum] ?? `Crossref hatası: ${sonuc.durum}`;
          console.log(`   – ${mesaj}`);
          bosKalanlar.push({ ...p, sebep: mesaj });
        }
      } catch (err) {
        console.log(`   ! hata: ${err.message}`);
        bosKalanlar.push({ ...p, sebep: err.message });
      }
    }

    if (i < kayitlar.length - 1) await bekle(DELAY_MS);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${dolduruldu} kayıt dolduruldu, ${bosKalanlar.length} kayıt boş kaldı.`);

  if (bosKalanlar.length) {
    console.log(`\nELLE DOLDURULACAKLAR`);
    console.log(`Supabase → Table Editor → publications → abstract sütunu\n`);
    for (const p of bosKalanlar) {
      console.log(`  id: ${p.id}`);
      console.log(`  ${String(p.title ?? '').slice(0, 70)}`);
      console.log(`  DOI: ${p.doi}`);
      console.log(`  Sebep: ${p.sebep}\n`);
    }
  }

  if (dolduruldu) {
    console.log(`Sırada: Actions → "Türkçe özet üret" → Run workflow`);
  }
}

main().catch(err => { console.error('ÖLÜMCÜL:', err); process.exit(1); });
