// Génère tools/search-vectors.json : référence de la recherche approximative (core.js `search`)
// que les apps Android et bureau doivent reproduire à l'identique (ordre compris).
import { search, fold } from '../server/web/assets/core.js';
import { writeFileSync } from 'node:fs';

const items = [
  { name: 'GitHub', username: 'fabio@example.net', uris: ['https://github.com/login'], folder: 'Dev', fav: true },
  { name: 'Amazon', username: 'fabio@example.net', uris: ['https://www.amazon.fr'] },
  { name: 'Banque Populaire', username: '12345678', uris: ['https://www.banquepopulaire.fr'], folder: 'Finances' },
  { name: 'Boîte mail', username: 'fabio@example.net', uris: ['https://mail.proton.me'] },
  { name: 'Impôts', username: '1234567890123', uris: ['https://www.impots.gouv.fr'], folder: 'Administratif' },
  { name: 'Netflix', username: 'famille@example.net', uris: ['netflix.com'] },
  { name: 'Wi-Fi maison', folder: 'Maison' },
  { name: 'Infomaniak SSH - example.net', username: 'xyzw_martin', uris: ['ssh://xyzw.vps.infomaniak.com'], folder: 'Serveurs' },
  { name: 'Free Mobile', username: '98765432', uris: ['https://mobile.free.fr'] },
  { name: 'Crédit Agricole', username: 'client42', uris: ['https://www.credit-agricole.fr'], folder: 'Finances' },
  { name: 'Œuvre caritative', username: 'don@exemple.org' },
  { name: 'Google', username: 'fabio.martin@example.org', uris: ['https://accounts.google.com'], fav: true },
  { name: 'GitLab', username: 'fabio', uris: ['https://gitlab.com'], folder: 'Dev' },
  { name: 'Apple', username: 'lisa', uris: ['https://appleid.apple.com'] },
  { name: 'Apple Store', username: 'marc', uris: ['https://www.apple.com/store'] },
  { name: 'Apple ID', username: 'lisamartin@icloud.example', uris: ['https://appleid.apple.com'] },
];
const queries = ['', 'git', 'GIT', 'gthb', 'github', 'githbu', 'impots', 'IMPÔTS', 'credit', 'crédit agri', 'netflx', 'amzaon', 'amazn',
  'bnq', 'banque pop', 'mail fabio', 'fabio mail', 'martin', 'proton', 'infomaniak', 'infomanaik', 'ssh', 'oeuvre', 'œuvre', 'finances',
  'dev', 'g', 'applis', 'applisa', 'lisapple', 'lisapp', 'lisicl', 'icloudapple', 'applelis', 'idlisa', 'martinapp', 'lisaapple', 'marcapple', 'apple lisa', 'applemarc', 'lisa', 'zz', 'xyzxyz', 'gml', 'free', 'mobile free', 'wifi', 'wi-fi', 'maison'];
const out = queries.map((q) => ({ query: q, results: search(items, q).map((it) => it.name) }));
writeFileSync(new URL('./search-vectors.json', import.meta.url), JSON.stringify({
  comment: 'Généré par make-search-vectors.mjs depuis core.js. Pour chaque requête : noms des entrées trouvées, dans l\'ordre exact.',
  fold: [['Impôts', fold('Impôts')], ['Œuvre Æther', fold('Œuvre Æther')], ['CRÉDIT', fold('CRÉDIT')]],
  items: items.map(({ _fz, ...it }) => it), vectors: out,
}, null, 1));
for (const v of out) console.log(JSON.stringify(v.query).padEnd(15), '→', v.results.join(', ') || '(aucun)');
