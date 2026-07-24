# PDF Editor (type sejda.com)

Application web self-hosted d'édition de PDF : l'utilisateur importe un PDF, modifie le **contenu existant** (texte en place, images), puis exporte une nouvelle version. Déploiement sur VPS Hostinger via Coolify (100% Docker, pas de Nginx à configurer — Coolify/Traefik gère le proxy et le TLS).

## Architecture (3 conteneurs)

| Service | Chemin | Techno | Rôle |
|---|---|---|---|
| `app` | `app/` | Next.js 16 (App Router, Turbopack) + shadcn/ui (preset base-nova, Base UI) + Tailwind v4 + pdf.js | UI, auth (Better Auth), API documents/versions, rendu PDF |
| `pdf-service` | `pdf-service/` | Python FastAPI + PyMuPDF | Extraction de structure (spans texte + images), application des éditions, export. **Réseau interne uniquement, jamais exposé** |
| `db` | — | PostgreSQL 17 | users, documents, document_versions |

- ORM : **Drizzle** (schéma dans `app/db/schema.ts`, migrations SQL générées par `npm run db:generate` dans `app/drizzle/`, appliquées au démarrage du conteneur `app` par `app/scripts/migrate.mjs`). Attention : la sortie standalone de Next bundle les deps serveur, donc l'image Docker installe drizzle-orm+pg séparément pour le script de migration (voir `app/Dockerfile`).
- Fichiers PDF : volume Docker `pdf_files` monté dans `app` et `pdf-service` sous `/data/files/<userId>/<documentId>/<versionId>.pdf`. Les binaires ne vont JAMAIS en base.
- Versions **immuables** : l'original importé = version 0 ; chaque export crée une nouvelle version ; toute version est réouvrable dans l'éditeur.
- PDF signés : édités comme les autres ; les champs de signature sont supprimés à l'export (aucune préservation/re-signature requise — décision validée).

## Flux d'édition (cœur du produit)

1. Upload → disque + ligne en base (version 0).
2. Ouverture éditeur → `pdf-service` extrait la structure : spans de texte (bbox, police, taille, couleur, flags gras/italique) et images (bbox) → le front superpose des calques interactifs alignés sur le rendu pdf.js.
3. Le front accumule un **journal d'opérations** JSON (modif texte, remplacement/suppression image).
4. Export → `pdf-service` rejoue le journal sur le PDF source (rédaction ciblée + réinsertion pour le texte, `replace_image`/`delete_image` pour les images) → nouvelle version.

Typographie (implémentée étape 6, `choose_font` dans `pdf-service/main.py`) : 1) réemploi de la police embarquée du span si elle s'extrait (ttf/otf/cff) ET que sa cmap couvre les glyphes du nouveau texte (`pymupdf.Font.has_glyph`) — les sous-ensembles Identity-H sans cmap échouent ce test et c'est voulu (impossible de mapper unicode→glyphe) ; 2) sinon repli sur police libre métriquement proche (Liberation Sans/Serif/Mono selon l'heuristique de nom, puis Noto/DejaVu) avec graisse/italique corrects ; 3) dernier recours base-14. Insertion via `TextWriter` (unicode complet). Retaillage : si le texte dépasse la largeur dispo (max bbox / marge droite), la taille est réduite proportionnellement (plancher 6 pt). L'appariement span↔ressource tolère préfixe de subset et espaces (`find_embedded_font`). Le rewrap multi-lignes n'existe pas (édition span par span). Les polices libres sont installées dans l'image Docker (fonts-liberation, fonts-noto-core, fonts-dejavu-core).

## Plan de développement (état d'avancement)

- [x] **Étape 1 — Socle** : scaffolding Next.js + shadcn, FastAPI + PyMuPDF, docker-compose (Coolify), Postgres + Drizzle, healthchecks. Critère : `docker compose up` fonctionne de bout en bout. ✅ vérifié le 2026-07-24 (health app+db+pdf-service, migrations auto, volume partagé lisible/inscriptible des deux côtés, garde anti path-traversal).
- [x] **Étape 2 — Auth + Mes documents** : Better Auth (email/mdp, sessions), upload PDF (validation type/taille), page "Mes documents" (liste, versions, suppression), cloisonnement strict par utilisateur. ✅ vérifié le 2026-07-24 en dev ET dans la stack Docker (signup/login, upload+magic bytes, download, suppression, accès inter-utilisateurs → 404, redirection des pages protégées).
- [x] **Étape 3 — Visionneuse + extraction** : rendu pdf.js multi-pages, endpoint d'extraction de structure, calque interactif (survol/sélection spans + images). ✅ vérifié le 2026-07-24 en dev (navigateur headless : canvas peints, calques alignés, sélection → style détecté police/taille/couleur/gras-italique, images PNG/ICC et JPEG rendues) et dans la stack Docker.
- [x] **Étape 4 — MVP édition de texte** : édition inline avec style détecté → journal d'opérations → export → nouvelle version réouvrable. Suppression des champs de signature. **Fin du MVP.** ✅ vérifié le 2026-07-24 : navigateur headless (édition inline stylée, export, réouverture v1 avec texte modifié devenu contenu réel), unit tests export PyMuPDF (style préservé, spans voisins/images intacts, widget signature supprimé), cloisonnement de la route export, stack Docker.
- [x] **Étape 5 — Images** : suppression et remplacement d'images existantes (image de substitution redimensionnée dans la bbox d'origine). ✅ vérifié le 2026-07-24 : unit tests venv (pixel remplacé exact, zone supprimée vierge, xref invalide refusé) + navigateur headless (aperçu, export, réouverture, probe pixels) + stack Docker.
- [x] **Étape 6 — Fidélité typographique avancée** : réemploi polices embarquées, mapping vers polices libres, gras/italique fin, retaillage. ✅ vérifié le 2026-07-24 : subset avec cmap → réemploi "embedded" ; glyphes manquants/accents → repli Liberation avec graisse correcte ; texte trop long → taille réduite ; flux navigateur et stack Docker OK. (Le re-wrap multi-lignes d'un bloc n'est pas couvert — édition span par span.)
- [ ] **Étape 7 — Durcissement + déploiement** : limites taille/quota, traitement asynchrone des gros PDF, nettoyage fichiers orphelins, corpus de test (Word, scannés, signés), déploiement Coolify.

Mettre à jour les cases à cocher au fil des sessions.

## Conventions

- **UI en français** (libellés : "Mes documents", etc.). Code, identifiants et commits en anglais.
- **shadcn/ui obligatoire pour l'UI** : suivre le skill `.agents/skills/shadcn/SKILL.md` (composants via `npx shadcn@latest add`, tokens sémantiques, `FieldGroup`/`Field` pour les formulaires, jamais de `space-y-*`, icônes avec `data-icon`).
- `app` est le seul service exposé (port 3000). `pdf-service` n'est joignable que via le réseau Docker interne (`PDF_SERVICE_URL`).
- Toute requête documents/versions filtre par `userId` de la session — jamais de confiance dans un id client.

## Commandes

- Dev local : `docker compose -f compose.dev.yml up -d` (Postgres seul), puis `npm run dev` dans `app/` et `.venv/bin/uvicorn main:app --reload --port 8000` dans `pdf-service/` (venv : `pdf-service/.venv`).
- Test prod local : `POSTGRES_PASSWORD=... docker compose -f docker-compose.yml -f compose.local.yml up --build` (le compose principal ne mappe aucun port hôte — c'est Coolify/Traefik qui route vers `app:3000` en prod).
- Migrations : `npm run db:generate` après modif du schéma (commiter `app/drizzle/`) ; appliquées automatiquement au démarrage du conteneur, ou `npm run db:migrate` en dev.
- Secrets attendus : voir `.env.example`.
- Piège connu : si `npm ci` échoue dans le build Docker avec "Missing @emnapi/... from lock file" (bug npm sur les deps optionnelles par plateforme, réintroduit à chaque `npm install <pkg>` local), régénérer le lockfile : `rm -rf node_modules package-lock.json && npm install` dans `app/`. Le Dockerfile épingle aussi npm à la version locale (11.6.2) pour immuniser le build — garder les deux versions alignées.
- Auth : Better Auth. Schéma généré dans `app/db/auth-schema.ts` (ne pas éditer à la main — régénérer via `npx @better-auth/cli generate --config lib/auth.ts --output db/auth-schema.ts` après changement de config), ré-exporté par `db/schema.ts`. Helpers : `lib/session.ts` (`getSession`, `requireSession`), client React `lib/auth-client.ts`.
- UI : projet Base UI (pas Radix) → les triggers utilisent `render={<Button/>}` (avec `nativeButton={false}` si le render est un lien), le toast s'utilise via `toast.add({type, title, description})` (`components/ui/toast.tsx`, `<Toaster>` monté dans le layout racine).
- pdf.js (v6) : la visionneuse est `components/editor/pdf-editor.tsx` (route `/documents/[documentId]/versions/[versionId]`). Pièges : appeler `render({canvas, viewport})` (pas `canvasContext` en plus) ; les décodeurs wasm (qcms/ICC, openjpeg, jbig2) doivent être servis en statique → `scripts/copy-pdfjs-assets.mjs` les copie dans `public/pdfjs/wasm/` (hook predev/prebuild, dossier gitignoré) et `getDocument` reçoit `wasmUrl: "/pdfjs/wasm/"`, sinon les images ICC/JPX sont silencieusement ignorées. Les bbox PyMuPDF (origine en haut à gauche) se projettent en pourcentages directement sur le canvas pdf.js.
- Vérif navigateur : Chromium système + playwright-core (scripts jetables dans le scratchpad) — vérifier le rendu réel des canvas et calques après toute modif de l'éditeur, un `curl` ne suffit pas.
- Export (étapes 4-5) : le front accumule `edits` (spanId → nouveau texte) et `imageEdits` (imageId → delete/replace avec dataURL) et envoie un journal `EditOperation[]` (`lib/pdf-structure.ts` : edit_text, delete_image, replace_image avec image en base64) à `POST /api/documents/[id]/versions`, qui appelle `pdf-service /documents/export` : rédaction ciblée (`apply_redactions` avec `images=NONE, graphics=NONE` pour ne pas effacer images/traits), réinsertion à l'`origin` (baseline) du span, police base-14 la plus proche (`pick_font` — le réemploi des polices embarquées est l'étape 6), `page.replace_image`/`page.delete_image` (xref validé contre les images de la page), suppression des widgets signature, `save(garbage=3, deflate=True)`. Versions immuables : le service refuse d'écraser une cible existante (409).
- Extraction images : `get_image_info(xrefs=True)` (images réellement dessinées), PAS `get_images` qui liste aussi les ressources périmées laissées par replace/delete ; on filtre xref 0 (inline) et les placeholders 1×1 de `delete_image`.
