/**
 * Feather Moon Crystals — crystal library builder
 * Reads crystalDatabase from index.html, extracts raw + effective names,
 * fetches Wikipedia REST summaries for external identity grounding,
 * merges conservative metaphysical fields from the app's catalog strings.
 *
 * Run: node build-crystal-library.mjs
 */
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, 'index.html');
const OUT_JSON = path.join(__dirname, 'crystal-library.json');
const OUT_EXTRACTION = path.join(__dirname, 'crystal-library-extraction.json');
const OUT_DUPES = path.join(__dirname, 'crystal-library-duplicates-review.md');

const UA = 'FeatherMoonCrystalLibraryBot/1.0 (contact: shop; educational dataset)';

function readHtml() {
  return fs.readFileSync(INDEX_PATH, 'utf8');
}

function extractCrystalDatabaseBlock(html) {
  const start = html.indexOf('const crystalDatabase = {');
  if (start === -1) throw new Error('crystalDatabase start not found');
  const end = html.indexOf('\n  };', start);
  if (end === -1) throw new Error('crystalDatabase end not found');
  const block = html.slice(start, end + '\n  };'.length);
  return block;
}

/** Top-level crystal keys in literal source order (includes duplicates if repeated keys). */
function extractRawKeysInOrder(block) {
  const inner = block.replace(/^const crystalDatabase\s*=\s*\{/, '').replace(/\}\s*;?\s*$/, '');
  const keys = [];
  // Only top-level entries look like "Name":{ ... } — ignore inner "intentions": etc.
  const re = /"((?:\\.|[^"\\])*)"\s*:\s*\{/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    keys.push(JSON.parse(`"${m[1]}"`));
  }
  return keys;
}

function parseCrystalDatabaseObject(html) {
  const start = html.indexOf('const crystalDatabase = {');
  if (start === -1) throw new Error('crystalDatabase start not found');
  let depth = 0;
  let i = html.indexOf('{', start);
  if (i === -1) throw new Error('opening brace not found');
  const begin = i;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const objSrc = html.slice(begin, i + 1);
        return Function(`"use strict"; return (${objSrc});`)();
      }
    }
  }
  throw new Error('could not parse crystalDatabase object');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          } else {
            resolve({ __status: res.statusCode, __body: data.slice(0, 500) });
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(25000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

/** Wikipedia REST v1 summary (external). */
async function fetchWikiSummary(title) {
  const enc = encodeURIComponent(title.replace(/ /g, '_'));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${enc}`;
  return httpsGetJson(url);
}

function wikiTitleCandidates(displayName) {
  const out = [];
  const push = (s) => {
    const t = (s || '').trim();
    if (t && !out.includes(t)) out.push(t);
  };
  push(displayName);
  // Strip trailing parenthetical variant: "Fluorite (Blue)" -> "Fluorite"
  const paren = displayName.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    push(paren[1].trim());
    // "Color Mineral" style
    push(`${paren[2].trim()} ${paren[1].trim()}`);
  }
  // Common rewrites
  const manual = {
    "Clear Quartz": 'Quartz',
    "Black Tourmaline": 'Schorl',
    "Tiger's Eye": "Tiger's eye (gemstone)",
    "Healer’s Gold": 'Pyrite', // composite; fallback mineral
    "Healer's Gold": 'Pyrite',
    "Auralite 23": 'Quartz',
    "Flower Agate": 'Chalcedony',
    "Tai Chi Jasper": 'Jasper',
    "Atlantisite": 'Serpentine subgroup',
    "Crystallized Fossil Wood": 'Silicified wood',
    "Ammonite Fossil": 'Ammonite',
    "Chrysotile Serpentine": 'Chrysotile',
    "Chrysotite (Serpentine)": 'Serpentine subgroup',
    "Chrysotile (Serpentine)": 'Chrysotile',
    "Diaspore (Zultanite)": 'Diaspore',
    "Blue Lace Agate": 'Chalcedony',
    "Green Aventurine": 'Aventurine',
    "Labradorite (Spectrolite)": 'Labradorite',
    "Lapis Lazuli (Pyrite Rich)": 'Lapis lazuli',
    "Lepidocrosite Quartz": 'Lepidocrocite',
    "Moss Agate (Dendritic)": 'Moss agate',
    "Moss Agate (Green with White)": 'Moss agate',
    "Peruvian Blue Opal": 'Opal',
    "Peruvian Opal": 'Opal',
    "Blue Tourmaline (Indicolite)": 'Elbaite',
    "Green Tourmaline (Verdelite)": 'Elbaite',
    "Watermelon Tourmaline": 'Elbaite',
    "Tourmaline (Watermelon Crystal)": 'Elbaite',
    "Tourmaline (Watermelon Slice)": 'Elbaite',
    "Black Obsidian (Apache Tear)": 'Obsidian',
    "Black Obsidian (Mahogany)": 'Obsidian',
    "Goldstone (Blue)": 'Goldstone (glass)',
    "Goldstone (Red)": 'Goldstone (glass)',
    "Zeolite": 'Zeolite',
    "Ajoite in Quartz": 'Ajoite',
  };
  if (manual[displayName]) push(manual[displayName]);
  return out;
}

function splitIntentions(s) {
  return (s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function splitChakras(s) {
  if (!s) return [];
  const lower = s.toLowerCase();
  if (lower.includes('all chakra') || lower === 'all') return ['All chakras'];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/** Very conservative birthstone-style zodiac hints (optional). */
function zodiacHintsForName(name) {
  const n = name.toLowerCase();
  const pairs = [];
  const add = (signs) => {
    for (const s of signs) if (!pairs.includes(s)) pairs.push(s);
  };
  if (n === 'garnet' || n.startsWith('garnet ')) add(['Capricorn', 'Aquarius']);
  if (n === 'amethyst') add(['Pisces', 'Aquarius']);
  if (n === 'aquamarine') add(['Pisces', 'Aries', 'Gemini', 'Scorpio']);
  if (n === 'diamond') add(['Aries']);
  if (n === 'emerald' || n.startsWith('emerald ')) add(['Taurus', 'Gemini', 'Cancer']);
  if (n === 'pearl') add(['Cancer', 'Gemini']);
  if (n === 'ruby' || n.startsWith('ruby')) add(['Cancer', 'Leo']);
  if (n === 'peridot' || n.startsWith('peridot')) add(['Leo', 'Virgo']);
  if (n === 'sapphire' || n.startsWith('sapphire')) add(['Virgo', 'Libra']);
  if (n.includes('opal')) add(['Libra', 'Scorpio']);
  if (n === 'citrine' || n.includes('topaz')) add(['Scorpio', 'Sagittarius']);
  if (n === 'turquoise' || n.includes('turquoise')) add(['Sagittarius', 'Pisces']);
  if (n === 'moonstone' || n.startsWith('moonstone')) add(['Cancer', 'Libra', 'Scorpio']);
  return pairs.slice(0, 4);
}

function extractCountriesFromText(text) {
  if (!text) return [];
  const countries = [
    'Brazil', 'India', 'Madagascar', 'China', 'Morocco', 'Mexico', 'Peru', 'Pakistan',
    'Afghanistan', 'Namibia', 'South Africa', 'Indonesia', 'Sri Lanka', 'United States', 'USA',
    'Canada', 'Australia', 'Russia', 'Myanmar', 'Tanzania', 'Zambia', 'Colombia', 'Dominican Republic',
    'Greenland', 'Germany', 'Norway', 'Finland', 'Italy', 'Spain', 'France', 'United Kingdom',
    'Japan', 'South Korea', 'Chile', 'Argentina', 'Bolivia', 'Ethiopia', 'Kenya', 'Nigeria',
    'Congo', 'Democratic Republic of the Congo', 'Zimbabwe', 'Mozambique', 'Egypt', 'Israel',
    'Iran', 'Turkey', 'Nepal', 'Thailand', 'Vietnam', 'New Zealand',
  ];
  const found = [];
  for (const c of countries) {
    if (text.includes(c) && !found.includes(c)) found.push(c);
  }
  return found.slice(0, 8);
}

function buildSeo(name, category) {
  const primary = `${name} crystal`;
  const secondary = [
    `${name} meaning`,
    `${name} properties`,
    `${name} metaphysical`,
    `${name} for sale`,
    category ? `${name} ${category}` : null,
  ].filter(Boolean);
  const tags = [
    'crystals',
    'gemstones',
    'metaphysical',
    category ? category.toLowerCase() : null,
  ].filter(Boolean);
  return { primary_keyword: primary, secondary_keywords: secondary, collection_tags: tags };
}

function buildProfile(displayName, entry, wiki) {
  const intentions = splitIntentions(entry.intentions);
  const chakras = splitChakras(entry.chakra);
  const wikiExtract = (wiki && wiki.extract) ? String(wiki.extract).replace(/\s+/g, ' ').trim() : '';
  const wikiTitle = wiki && wiki.title ? wiki.title : '';
  const wikiUrl = wiki && wiki.content_urls && wiki.content_urls.desktop ? wiki.content_urls.desktop.page : '';

  const colorRange = [];
  const descLower = (entry.description || '').toLowerCase();
  if (descLower.includes('blue')) colorRange.push('blue tones');
  if (descLower.includes('green')) colorRange.push('green tones');
  if (descLower.includes('pink')) colorRange.push('pink tones');
  if (descLower.includes('purple') || descLower.includes('violet')) colorRange.push('purple tones');
  if (descLower.includes('yellow') || descLower.includes('golden')) colorRange.push('yellow to golden tones');
  if (descLower.includes('orange') || descLower.includes('red-orange')) colorRange.push('orange to red-orange tones');
  if (descLower.includes('red')) colorRange.push('red tones');
  if (descLower.includes('black') || descLower.includes('dark')) colorRange.push('dark tones');
  if (descLower.includes('white') || descLower.includes('clear')) colorRange.push('clear to white tones');
  if (descLower.includes('brown') || descLower.includes('earthy')) colorRange.push('earthy brown tones');
  if (descLower.includes('multicolor') || descLower.includes('rainbow') || descLower.includes('colorful')) colorRange.push('multicolor');
  if (!colorRange.length) colorRange.push('natural color varies');

  const appearance_notes = [
    entry.description,
    wikiExtract ? `Wikipedia summary (${wikiTitle}): ${wikiExtract}` : null,
    wikiUrl ? `Read more: ${wikiUrl}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const common_sources = extractCountriesFromText(wikiExtract + ' ' + (entry.description || ''));

  const core = intentions.slice(0, 6);
  const emotional = intentions.filter((t) =>
    /love|calm|peace|stress|emotion|heart|compassion|joy|grief|release|balance|heal/i.test(t)
  );
  const spiritual = intentions.filter((t) =>
    /spirit|intuition|aware|angel|higher|meditat|transform|magic|psychic|crown|third/i.test(t)
  );
  const uses = intentions.filter((t) =>
    /ground|protect|clarity|focus|communicat|manifest|creat|abund|cleans|amplif/i.test(t)
  );

  return {
    crystal_name: displayName,
    aliases: [],
    identity: {
      color_range: colorRange,
      appearance_notes,
      common_sources: common_sources.length ? common_sources : ['Various worldwide sources (see mineralogy references)'],
    },
    metaphysical: {
      core_themes: core.length ? core : ['Supportive energetic focus (personal practice)'],
      emotional_support: emotional.length ? emotional : ['Emotional balance (non-medical, personal practice)'],
      spiritual_themes: spiritual.length ? spiritual : ['Mindfulness and reflection (personal practice)'],
      chakra_associations: chakras,
      zodiac_associations: zodiacHintsForName(displayName),
      common_uses: uses.length ? uses : ['Meditation', 'Altar display', 'Carry stone', 'Jewelry'],
    },
    seo: buildSeo(displayName, entry.category),
  };
}

function duplicateAnalysis(rawKeys) {
  const counts = {};
  for (const k of rawKeys) counts[k] = (counts[k] || 0) + 1;
  const exactDupes = Object.entries(counts)
    .filter(([, n]) => n > 1)
    .map(([k, n]) => ({ key: k, occurrences: n }));
  return exactDupes;
}

function nearDuplicateGroups(names) {
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/[’']/g, "'")
      .replace(/\s*\([^)]*\)/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const g = {};
  for (const n of names) {
    const key = norm(n);
    if (!g[key]) g[key] = [];
    g[key].push(n);
  }
  return Object.values(g)
    .filter((arr) => arr.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

async function main() {
  const extractOnly = process.argv.includes('--extract-only');
  const html = readHtml();
  const block = extractCrystalDatabaseBlock(html);
  const rawKeys = extractRawKeysInOrder(block);
  const db = parseCrystalDatabaseObject(html);
  const effective = Object.keys(db).sort((a, b) => a.localeCompare(b));

  const exactDupes = duplicateAnalysis(rawKeys);
  const nearGroups = nearDuplicateGroups(effective);

  fs.writeFileSync(
    OUT_EXTRACTION,
    JSON.stringify(
      {
        source_file: INDEX_PATH,
        raw_key_count: rawKeys.length,
        effective_unique_count: effective.length,
        raw_keys_in_source_order: rawKeys,
        effective_names_alphabetical: effective,
        exact_duplicate_keys_in_literal: exactDupes,
      },
      null,
      2
    ),
    'utf8'
  );

  let md = `# Crystal name duplicate review\n\n`;
  md += `Source: \`${INDEX_PATH}\`\n\n`;
  md += `## Exact duplicate keys in object literal (later overwrites earlier)\n\n`;
  if (!exactDupes.length) md += `_None found._\n\n`;
  else {
    for (const d of exactDupes) {
      md += `- **${d.key}** appears **${d.occurrences}** times\n`;
    }
    md += '\n';
  }
  md += `## Near-duplicate name groups (normalized base string)\n\n`;
  md += `_Review only. Do not merge without human confirmation._\n\n`;
  for (const grp of nearGroups) {
    md += `- ${grp.map((x) => `\`${x}\``).join(' / ')}\n`;
  }
  fs.writeFileSync(OUT_DUPES, md, 'utf8');

  if (extractOnly) {
    console.log('Extract-only: wrote', OUT_EXTRACTION, OUT_DUPES);
    return;
  }

  const library = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: 'Pictures/index.html#crystalDatabase',
    research_basis:
      'Identity fields grounded in Wikipedia REST API summaries (en.wikipedia.org). Metaphysical fields derived from the app catalog strings (intentions/chakra) plus conservative phrasing; no medical claims.',
    crystals: [],
  };

  let i = 0;
  for (const name of effective) {
    i++;
    const entry = db[name];
    let wiki = null;
    const candidates = wikiTitleCandidates(name);
    for (const title of candidates) {
      const res = await fetchWikiSummary(title);
      if (res && !res.__status && res.extract) {
        wiki = res;
        break;
      }
      await sleep(120);
    }
    library.crystals.push(buildProfile(name, entry, wiki));
    if (i % 25 === 0) console.error(`Progress: ${i}/${effective.length}`);
    await sleep(280);
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(library, null, 2), 'utf8');
  console.log('Wrote', OUT_JSON);
  console.log('Wrote', OUT_EXTRACTION);
  console.log('Wrote', OUT_DUPES);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
