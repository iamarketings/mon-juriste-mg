# Mon juriste

Pipeline locale de collecte des textes juridiques publics de [CNLEGIS Madagascar](https://cnlegis.gov.mg/), préparée pour un RAG hébergé sur Cloudflare Workers avec D1, R2 et Vectorize. Workers AI n'est pas utilisé : les embeddings sont produits localement et la génération passe par un fournisseur interchangeable, OpenRouter en premier.

Application publique : [monjuris-mg.aheshman-itibar.workers.dev](https://monjuris-mg.aheshman-itibar.workers.dev/)

## Aperçu de l'application

Une réponse juridique issue de la version publique, avec ses articles et ses liens vers les textes consultés :

![Mon juriste sur ordinateur : réponse juridique et sources](docs/screenshots/desktop-reponse.jpg)

<p align="center">
  <img src="docs/screenshots/mobile-assistant.jpg" alt="Accueil de l'assistant juridique sur mobile" width="290" />
  <img src="docs/screenshots/mobile-reponse.jpg" alt="Réponse juridique et citations sur mobile" width="290" />
</p>

Les [six captures originales](docs/screenshots/README.md) sont disponibles pour présenter le projet sur un portfolio ou sur LinkedIn.

L'interface est une PWA installable conçue mobile-first. Avant le premier usage, elle demande le nom, l'adresse e-mail et le téléphone de l'utilisateur avec son accord explicite. Les coordonnées et un hash du jeton d'accès sont stockés dans D1 ; le navigateur conserve le profil et le jeton brut dans `localStorage` afin de ne pas redemander l'inscription sur le même appareil.

Le périmètre initial est volontairement limité à :

- droit civil ;
- droit du travail ;
- droit commercial ;
- droit des sociétés et groupements.

L'outil n'utilise aucun LLM pour lire ou transformer les documents. Le texte natif des PDF est extrait avec `pypdf`, le HTML est nettoyé localement, le JSONL est produit par Python et l'OCR facultatif utilise uniquement Tesseract sur la machine. Les pages faibles ou illisibles restent marquées `partial` ou `needs_ocr` et sont exclues de l'export RAG par défaut.

## Installation

Python 3.11 ou plus récent :

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -e .
```

Pour l'OCR local, installer Tesseract avec les données françaises, puis :

```powershell
python -m pip install -e ".[ocr]"
tesseract --list-langs
```

Tesseract reste optionnel. Il n'est lancé que pour les pages dont l'extraction native est insuffisante.

## Utilisation

Un essai borné permet de contrôler le fonctionnement sans collecter le corpus entier :

```powershell
monjuris --data data discover --limit-documents 10
monjuris --data data fetch --limit-assets 10
monjuris --data data export --d1-sql
```

Collecte complète du périmètre configuré :

```powershell
monjuris --data data run
```

Reprendre les PDF incomplets avec l'OCR local :

```powershell
monjuris --data data fetch --ocr tesseract --ocr-languages fra
```

Pour éviter d'appliquer le modèle français aux scans malgaches, limiter explicitement la reprise :

```powershell
monjuris --data data fetch --ocr tesseract --ocr-languages fra --language fr
```

Les commandes sont reprenables et idempotentes. `--refresh` réobserve les sources et conserve l'historique si un fichier a changé. Le client respecte `robots.txt`, maintient la session requise par le catalogue, limite les hôtes à `cnlegis.gov.mg`, temporise les requêtes et refuse les fichiers trop volumineux.

Pour inspecter l'état et effectuer une recherche textuelle locale :

```powershell
monjuris --data data status
monjuris --data data search "société à responsabilité limitée"
```

## Données produites

`data/catalog.sqlite3` contient le catalogue de travail, les versions, les tâches reprenables et les chunks. Les originaux restent sous `data/raw/` et les extractions page par page sous `data/text/`.

`data/exports/` contient :

- `documents.jsonl` : catalogue et métadonnées de provenance ;
- `versions.jsonl` : hashes, langue, source, qualité d'extraction et chemins R2 futurs ;
- `chunks.jsonl` : unités prêtes pour les embeddings avec article et pages sources ;
- `quality.json` : erreurs, textes incomplets et notices sans document intégral ;
- `manifest.json` : intégrité, compteurs et statut de complétude ;
- `d1/*.sql` avec `--d1-sql` : schéma et lots de données importables dans D1.

Seules les versions courantes avec extraction `ready` entrent dans `chunks.jsonl`. Les textes marqués abrogés sont exclus par défaut ; leur catalogue et leurs originaux restent conservés. Un statut CNLEGIS `En vigueur` ou `unknown` n'est pas une consolidation juridique indépendante.

Le contrat Cloudflare et les choix de provenance sont détaillés dans [docs/cloudflare.md](docs/cloudflare.md). Le modèle d'embeddings sera choisi à l'étape RAG afin d'adapter le découpage à son tokenizer réel.

## Worker RAG local avec Miniflare

Le Worker TypeScript se trouve sous `worker/`. Wrangler lance Miniflare avec une base D1 et un bucket R2 strictement locaux. Workers AI n'est jamais appelé. Vectorize n'ayant pas de simulateur local, le développement utilise D1 FTS5 ; le code active la recherche hybride lorsqu'un binding Vectorize distant et un fournisseur d'embeddings compatible OpenAI sont configurés.

La recherche lexicale développe les sigles CDD/CDI, ignore les mots courants et privilégie le contenu des articles. Elle conserve les correspondances directes et ajoute des articles voisins de plusieurs sections. L'interface demande jusqu'à 20 passages ; les relances courtes conservent le sujet de la conversation. Une recherche infructueuse ne prouve pas qu'une disposition est absente du corpus.

L'historique est borné et nettoyé de ses listes de sources et de ses anciens marqueurs de citation avant génération. Les références de l'analyse sont contrôlées contre les passages actuels ; si la reformulation change les références, l'analyse sourcée est conservée. Ce contrôle porte sur les références et ne constitue pas une vérification indépendante de chaque interprétation juridique. L'interface affiche les erreurs avec un bouton « Réessayer ».

Installer les dépendances, préparer D1 avec le corpus exporté, puis démarrer le serveur :

```powershell
pnpm install
pnpm run db:setup
pnpm dev
```

Le serveur écoute par défaut sur `http://127.0.0.1:8787`. Les routes sont :

- `GET /health` : état opérationnel minimal ;
- `POST /v1/register` : enregistrement initial du nom, de l'e-mail et du téléphone dans D1 ;
- `POST /v1/retrieve` : recherche avec textes et citations, avec jeton d'accès ;
- `POST /v1/chat` : recherche puis génération de la réponse, avec jeton d'accès.

La génération utilise un fournisseur compatible OpenAI. JEV réalise l'analyse juridique et Ling 3.0 Flash présente la réponse. Pour tester OpenRouter, copier `.dev.vars.example` vers `.dev.vars` et y placer `LLM_API_KEY`. Ce fichier est ignoré par Git. Le fournisseur et les modèles restent internes et ne sont jamais renvoyés par l'API publique.

Exemple de recherche :

```powershell
$body = @{
  query = "obligations employeur sécurité travail"
  limit = 5
  filters = @{ category = "DROIT DU TRAVAIL"; language = "fr" }
} | ConvertTo-Json -Depth 4

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8787/v1/retrieve" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

Vérification locale :

```powershell
pnpm run check
pnpm test
```

## Configuration

Le périmètre, le délai entre requêtes, les limites de téléchargement et la taille des chunks sont définis dans [config/scope.json](config/scope.json). Les thèmes doivent correspondre exactement aux libellés publics du site.

## Déploiement Cloudflare

Le Worker sert l'API et les fichiers statiques compilés depuis `web/dist`. La clé du fournisseur doit rester dans un secret Cloudflare et ne doit jamais être ajoutée au dépôt :

```powershell
pnpm run build
pnpm exec wrangler secret put LLM_API_KEY
pnpm exec wrangler deploy
```

Les migrations D1 se trouvent dans `worker/migrations/`. Le binding de production utilise `monjuris-db` et le bucket `monjuris-documents`.

## Vérification

```powershell
$env:PYTHONPATH = "$PWD\src"
python -m unittest discover -s tests -v
```
