// ============================================================
//  Yayın sayfası üretici — her onaylı yayın için statik HTML
//  Node 18+ (yerleşik fetch, ek paket YOK). GitHub Actions'ta çalışır.
// ============================================================

import { writeFile, mkdir, rm } from 'node:fs/promises';

// ==================== AYARLAR ====================
const SUPABASE_URL = 'https://epxdfwryvlpolmjyqfgb.supabase.co';
// Bu "publishable" (anon) anahtar zaten sitende herkese açık — gizli değil, sorun yok.
const SUPABASE_KEY = 'sb_publishable_I32iVvzmTUH_tjs3ZAouRw_s6TtqnxO';
const TABLE        = 'publications';
const SITE         = 'https://yavuz-unal.github.io'; // sonda / YOK
const OUT_DIR      = 'y';            // yayın sayfaları buraya: /y/<slug>.html
const DIZIN_SAYFA  = 'yayin-dizini.html'; // "tüm yayınlara dön" linki

// ==================== ALAN EŞLEŞTİRME ====================
// Supabase tablondaki sütun adları farklıysa SADECE burayı düzelt.
// (Script ilk çalıştığında gerçek sütun adlarını konsola yazacak — oradan kontrol et.)
const F = {
  id:       'id',
  title:    'title',
  authors:  'authors',
  journal:  'journal',
  year:     'year',
  doi:      'doi',
  link:     'link',
  category: 'category',
};

// ==================== YARDIMCILAR ====================
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Crossref'ten gelen gömülü etiketleri ve özel karakterleri temizle
function temizle(ham) {
  if (ham == null) return ham;
  return String(ham)
    .replace(/<[^>]+>/g, '')                                   // <scp>, <i>, <sub> vb.
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013]/g, '-')               // özel tireler → normal
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(s) {
  const map = { 'ı':'i','İ':'i','ş':'s','Ş':'s','ğ':'g','Ğ':'g','ü':'u','Ü':'u','ö':'o','Ö':'o','ç':'c','Ç':'c' };
  return String(s ?? '')
    .replace(/[ıİşŞğĞüÜöÖçÇ]/g, c => map[c] || c)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'yayin';
}

function kirp(s, n) {
  s = String(s ?? '').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// "Ünal, Y.; Bolat, B. & Şen, A." -> ["Ünal, Y.", "Bolat, B.", "Şen, A."]
// Not: virgülle BÖLMÜYORUZ — "Soyad, İ." formatındaki virgül isim-içidir.
function yazarListesi(s) {
  return String(s ?? '')
    .split(/;|&|\band\b|\bve\b/i)
    .map(x => x.trim())
    .filter(Boolean);
}

function doiLink(p) {
  if (p[F.link]) return p[F.link];
  if (p[F.doi])  return 'https://doi.org/' + String(p[F.doi]).replace(/^https?:\/\/doi\.org\//, '');
  return '';
}

// APA'ya yakın basit künye metni
function kunye(p) {
  const parcalar = [];
  if (p[F.authors]) parcalar.push(String(p[F.authors]).trim().replace(/\.?$/, '.'));
  if (p[F.year])    parcalar.push('(' + p[F.year] + ').');
  if (p[F.title])   parcalar.push(String(p[F.title]).trim().replace(/\.?$/, '.'));
  if (p[F.journal]) parcalar.push(String(p[F.journal]).trim().replace(/\.?$/, '.'));
  const dl = doiLink(p);
  if (dl) parcalar.push(dl);
  return parcalar.join(' ');
}

// ==================== SAYFA ŞABLONU ====================
function sayfaHtml(p, slug) {
  const url      = `${SITE}/${OUT_DIR}/${slug}.html`;
  const baslik   = String(p[F.title] ?? 'Yayın').trim();
  const yazarlar = String(p[F.authors] ?? '').trim();
  const dergi    = String(p[F.journal] ?? '').trim();
  const yil      = p[F.year] ? String(p[F.year]) : '';
  const kat      = String(p[F.category] ?? '').trim();
  const dl       = doiLink(p);
  const aciklama = kirp([yazarlar, dergi, yil].filter(Boolean).join(', ') + (baslik ? ' — ' + baslik : ''), 155);

  // JSON-LD (Google akademik makale olarak tanısın)
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'ScholarlyArticle',
    headline: baslik,
    name: baslik,
    inLanguage: 'tr',
    url,
    ...(yazarlar && { author: yazarListesi(yazarlar).map(n => ({ '@type': 'Person', name: n })) }),
    ...(yil && { datePublished: yil }),
    ...(dergi && { isPartOf: { '@type': 'Periodical', name: dergi } }),
    ...(dl && { sameAs: dl }),
    ...(p[F.doi] && { identifier: { '@type': 'PropertyValue', propertyID: 'DOI', value: String(p[F.doi]) } }),
  };

  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(kirp(baslik, 65))} | Akademik Yayın Dizini</title>
<meta name="description" content="${esc(aciklama)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${esc(url)}">

<meta property="og:type" content="article">
<meta property="og:title" content="${esc(baslik)}">
<meta property="og:description" content="${esc(aciklama)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:locale" content="tr_TR">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(kirp(baslik, 70))}">
<meta name="twitter:description" content="${esc(aciklama)}">

<script type="application/ld+json">
${JSON.stringify(jsonld, null, 2)}
</script>

<style>
  :root { --ink:#16202e; --muted:#475569; --line:#e2e8f0; --accent:#1d4ed8; --bg:#ffffff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
         line-height:1.65; }
  .wrap { max-width:720px; margin:0 auto; padding:40px 22px 64px; }
  .geri { display:inline-block; margin-bottom:28px; color:var(--muted);
          text-decoration:none; font-size:.9rem; }
  .geri:hover { color:var(--accent); }
  .kat { display:inline-block; font-size:.75rem; letter-spacing:.04em; text-transform:uppercase;
         color:var(--accent); background:#eff6ff; padding:4px 10px; border-radius:999px; margin-bottom:14px; }
  h1 { font-size:1.55rem; line-height:1.3; margin:0 0 16px; }
  .yazarlar { color:var(--ink); font-size:1.02rem; margin:0 0 6px; }
  .dergi { color:var(--muted); font-style:italic; margin:0 0 24px; }
  .meta-satir { color:var(--muted); font-size:.95rem; margin:2px 0; }
  .doi-btn { display:inline-block; margin:26px 0; padding:11px 20px; background:var(--accent);
             color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:.95rem; }
  .doi-btn:hover { background:#1e40af; }
  .kunye-kutu { margin-top:34px; padding:18px 20px; background:#f8fafc;
                border:1px solid var(--line); border-radius:10px; }
  .kunye-kutu h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.05em;
                   color:var(--muted); margin:0 0 10px; }
  .kunye-metin { font-size:.92rem; color:var(--ink); word-break:break-word; }
  footer { margin-top:48px; padding-top:20px; border-top:1px solid var(--line);
           color:#94a3b8; font-size:.82rem; }
  footer a { color:#94a3b8; }
</style>
</head>
<body>
  <div class="wrap">
    <a class="geri" href="${SITE}/${esc(DIZIN_SAYFA)}">← Tüm yayınlara dön</a>

    ${kat ? `<div class="kat">${esc(kat)}</div>` : ''}
    <h1>${esc(baslik)}</h1>
    ${yazarlar ? `<p class="yazarlar">${esc(yazarlar)}</p>` : ''}
    ${(dergi || yil) ? `<p class="dergi">${esc([dergi, yil].filter(Boolean).join(', '))}</p>` : ''}

    ${p[F.doi] ? `<p class="meta-satir">DOI: ${esc(p[F.doi])}</p>` : ''}

    ${dl ? `<a class="doi-btn" href="${esc(dl)}" target="_blank" rel="noopener">Makaleye git →</a>` : ''}

    <div class="kunye-kutu">
      <h2>Atıf</h2>
      <p class="kunye-metin">${esc(kunye(p))}</p>
    </div>

    <footer>
      Bu sayfa <a href="${SITE}/${esc(DIZIN_SAYFA)}">Akademik Yayın Dizini</a> tarafından üretilmiştir.
    </footer>
  </div>
</body>
</html>`;
}

// ==================== HUB SAYFASI (/y/index.html) ====================
// Botların tüm yayın sayfalarına iç bağlantıyla ulaşabilmesi için basit statik liste.
function hubHtml(kayitlar) {
  const satirlar = kayitlar.map(({ p, slug }) => {
    const baslik = esc(String(p[F.title] ?? 'Yayın').trim());
    const alt    = esc([p[F.authors], p[F.journal], p[F.year]].filter(Boolean).join(' · '));
    return `    <li>
      <a href="${SITE}/${OUT_DIR}/${slug}.html">${baslik}</a>
      <div class="alt">${alt}</div>
    </li>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tüm Yayınlar | Akademik Yayın Dizini</title>
<meta name="description" content="Akademik Yayın Dizini'ndeki tüm yayınların listesi.">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${SITE}/${OUT_DIR}/">
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
         color:#16202e; line-height:1.6; background:#fff; }
  .wrap { max-width:760px; margin:0 auto; padding:40px 22px 64px; }
  h1 { font-size:1.6rem; }
  ul { list-style:none; padding:0; }
  li { padding:16px 0; border-bottom:1px solid #e2e8f0; }
  li a { color:#1d4ed8; text-decoration:none; font-size:1.05rem; font-weight:600; }
  li a:hover { text-decoration:underline; }
  .alt { color:#64748b; font-size:.88rem; margin-top:4px; }
  .geri { color:#475569; text-decoration:none; font-size:.9rem; }
</style>
</head>
<body>
  <div class="wrap">
    <a class="geri" href="${SITE}/${esc(DIZIN_SAYFA)}">← Ana dizine dön</a>
    <h1>Tüm Yayınlar</h1>
    <p style="color:#64748b">Toplam ${kayitlar.length} yayın.</p>
    <ul>
${satirlar}
    </ul>
  </div>
</body>
</html>`;
}

// ==================== SITEMAP ====================
function sitemapXml(kayitlar) {
  const bugun = new Date().toISOString().slice(0, 10);
  const sabitler = [
    { loc: `${SITE}/`,                     pr: '1.0' },
    { loc: `${SITE}/${DIZIN_SAYFA}`,       pr: '0.9' },
    { loc: `${SITE}/${OUT_DIR}/`,          pr: '0.7' },
  ];
  const yayinlar = kayitlar.map(({ slug }) => ({ loc: `${SITE}/${OUT_DIR}/${slug}.html`, pr: '0.6' }));
  const hepsi = [...sabitler, ...yayinlar];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${hepsi.map(u => `  <url>
    <loc>${esc(u.loc)}</loc>
    <lastmod>${bugun}</lastmod>
    <priority>${u.pr}</priority>
  </url>`).join('\n')}
</urlset>`;
}

// ==================== VERİ ÇEKME ====================
async function yayinlariGetir() {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}` +
              `?status=eq.approved&select=*&order=${F.year}.desc.nullslast`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Supabase hatası ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ==================== ANA AKIŞ ====================
async function main() {
  console.log('› Yayınlar çekiliyor…');
  const kayitlarHam = await yayinlariGetir();
  console.log(`› ${kayitlarHam.length} onaylı yayın bulundu.`);

  // Metin alanlarını temizle (gömülü etiketler, özel karakterler)
  for (const p of kayitlarHam) {
    for (const alan of [F.title, F.authors, F.journal, F.category]) {
      if (p[alan] != null) p[alan] = temizle(p[alan]);
    }
  }

  if (kayitlarHam.length) {
    console.log('› Tablodaki sütunlar:', Object.keys(kayitlarHam[0]).join(', '));
  }

  // Slug ata (çakışma olursa -2, -3 …)
  const gorulen = new Map();
  const kayitlar = kayitlarHam.map(p => {
    let slug = slugify(p[F.title]);
    if (gorulen.has(slug)) {
      const n = gorulen.get(slug) + 1;
      gorulen.set(slug, n);
      slug = `${slug}-${n}`;
    } else {
      gorulen.set(slug, 1);
    }
    return { p, slug };
  });

  // Çıktı klasörünü temizle ve yeniden oluştur
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  // Her yayın için sayfa yaz
  for (const { p, slug } of kayitlar) {
    await writeFile(`${OUT_DIR}/${slug}.html`, sayfaHtml(p, slug), 'utf8');
  }
  console.log(`› ${kayitlar.length} yayın sayfası yazıldı → /${OUT_DIR}/`);

  // Hub + sitemap
  await writeFile(`${OUT_DIR}/index.html`, hubHtml(kayitlar), 'utf8');
  await writeFile('sitemap.xml', sitemapXml(kayitlar), 'utf8');
  console.log('› index.html ve sitemap.xml güncellendi.');
  console.log('✓ Bitti.');
}

main().catch(err => { console.error('✗ HATA:', err.message); process.exit(1); });
