# Corpus CNLegis et futur RAG Cloudflare

Documentation vérifiée le 6 octobre 2026 auprès des sources officielles Cloudflare. Cette étape construit le corpus local : droit civil, droit du travail et textes concernant les entreprises. L'abonnement Workers payant peut héberger l'API et les données, mais le projet n'utilisera pas Workers AI. Les embeddings seront calculés hors de Cloudflare et la génération de Jev IA passera d'abord par OpenRouter.

## Répartition proposée

| Composant | Rôle dans l'étape suivante |
| --- | --- |
| R2 | Conserver les fichiers téléchargés et les textes extraits, sous les clés `raw_key` et `text_key` exportées. |
| D1 | Conserver le catalogue, les versions, les passages et leur provenance ; répondre aux recherches exactes et récupérer les citations. |
| Vectorize | Stocker les embeddings produits localement ; retourner des identifiants de passages à résoudre dans D1. Vectorize n'effectue aucune inférence. |
| Worker | Appliquer les filtres, combiner recherche lexicale et vectorielle, récupérer les textes/citations et exposer l'API RAG à Jev IA. |
| OpenRouter | Fournisseur initial de génération de texte, appelé par le Worker derrière une interface remplaçable. |

La séparation ci-dessus est un choix d'architecture du projet. Les fichiers sources restent consultables sans embeddings et un changement de modèle n'impose pas de refaire la collecte. D1 utilise SQLite et prend en charge FTS5 et les fonctions JSON, ce qui permet aussi une recherche lexicale sur les numéros de textes et d'articles. [SQL pris en charge par D1](https://developers.cloudflare.com/d1/sql-api/sql-statements/)

Workers AI ne doit être lié ni au Worker ni à la pipeline d'indexation. Vectorize accepte directement des tableaux de nombres et des imports NDJSON : les vecteurs peuvent donc être générés sur la machine de préparation avec un modèle libre, puis importés sans appeler un modèle Cloudflare. [Insertion de vecteurs](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/)

## Contrat des exports

Les fichiers JSONL sont encodés en UTF-8, avec un objet JSON par ligne. `null` signifie que l'information est absente ou n'a pas pu être déterminée ; il ne faut pas fabriquer une date, un article ou un numéro de page. Les champs `id`, `document_id` et `version_id` sont des identifiants opaques produits par la pipeline et doivent être conservés lors de l'import.

### `documents.jsonl`

Une ligne représente l'entrée du catalogue, indépendante des langues et fichiers disponibles.

| Champs | Usage |
| --- | --- |
| `id`, `source_id` | Identifiant interne et identifiant observé chez CNLegis. |
| `title`, `text_type`, `number`, `date` | Référence du texte telle que collectée ; `date` n'est pas une date d'entrée en vigueur présumée. |
| `category`, `categories` | Catégorie principale et liste des catégories du périmètre. |
| `source_url` | URL de la page ou liste CNLegis ayant fourni l'entrée. |
| `legal_status` | Statut indiqué par la source ; `unknown` si absent. |
| `notes`, `metadata` | Observations et données source complémentaires. |

La langue appartient à la version du fichier et n'est donc pas portée par le document.

### `versions.jsonl`

Une ligne représente une version collectée d'un document dans une langue donnée.

| Champs | Usage |
| --- | --- |
| `id`, `document_id`, `language` | Version identifiée par un hash hexadécimal de 64 caractères, son document parent et sa langue. |
| `source_url`, `source_sha256`, `fetched_at` | URL du fichier source, empreinte SHA-256 des octets téléchargés et date de collecte. |
| `raw_key`, `text_key` | Clés des fichiers source et texte extrait. Conserver ces chemins relatifs comme clés R2 lors du transfert. |
| `legal_status`, `is_current` | Statut source et version courante dans le catalogue de collecte. |
| `extraction_status`, `page_count`, `text_chars`, `warnings` | État et qualité observable de l'extraction. |

Les états d'extraction sont `ready`, `partial`, `needs_ocr`, `empty` et `error`. Un téléchargement réussi ne suffit pas à rendre un document exploitable. Un scan ou une extraction partielle reste dans le catalogue et dans les fichiers sources pour être repris.

`is_current` désigne la version actuellement retenue par la pipeline pour ce document et cette langue. Ce champ ne certifie ni la consolidation du texte ni son applicabilité juridique. Le contenu d'un même PDF peut correspondre à un texte ancien, même si le fichier vient d'être téléchargé.

### `chunks.jsonl`

Une ligne représente un passage exploitable pour la recherche.

| Champs | Usage |
| --- | --- |
| `id`, `document_id`, `version_id`, `ordinal` | Identifiant hexadécimal de 64 caractères, liens vers le catalogue et ordre du passage. |
| `text`, `text_sha256` | Texte extrait et empreinte permettant de détecter une modification. |
| `article`, `page_start`, `page_end` | Repères de citation identifiés lors de l'extraction. |
| `language`, `title`, `number`, `date` | Métadonnées lisibles de la source. |
| `source_url`, `legal_status`, `categories` | URL de la version, statut source et catégories. |

Par défaut, les passages exportés proviennent des versions `ready` et `is_current`. Les textes signalés comme abrogés sont conservés au catalogue mais exclus des passages exportés par défaut. Un statut `unknown` reste explicite dans les exports et dans les futures citations ; il ne doit pas être traduit en « en vigueur ».

Pour les PDF, `page_start` et `page_end` désignent les pages physiques du fichier, à partir de 1 ; leur numéro peut différer du numéro imprimé. Les textes extraits sans repère fiable gardent des pages `null`. `article` doit rester `null` si la structure n'est pas identifiée avec suffisamment de certitude. La future interface peut alors citer le titre, le numéro du texte et le lien source. Un lien `#page=N` peut compléter la citation PDF quand une page physique est disponible.

## Import et indexation à réaliser à l'étape 2

1. Copier les objets `raw_key` et `text_key` vers R2 sans changer leurs clés. Vérifier `source_sha256` sur les fichiers locaux avant transfert. Le hash de provenance doit rester indépendant de l'ETag ou de l'identifiant de version R2 : R2 expose séparément des informations d'ETag, de version et de checksum. [API R2 pour Workers](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
2. Importer `documents`, puis `document_versions`, puis `chunks` dans D1. Les données de suivi `asset_jobs` servent à la reprise de la collecte et restent séparées de l'index de recherche. Utiliser des requêtes préparées et des écritures idempotentes sur les identifiants.
3. Choisir un modèle d'embeddings libre et exécutable localement, adapté aux langues du corpus, puis mesurer sa qualité sur un jeu de questions réelles. `BAAI/bge-m3` constitue un premier candidat, sans passer par sa version Workers AI. Fixer le modèle, sa révision exacte, ses dimensions, la métrique et les paramètres de segmentation dans un manifeste d'indexation distinct. Le choix des dimensions et de la métrique de Vectorize est fixé à la création de l'index. [Création d'un index Vectorize](https://developers.cloudflare.com/vectorize/get-started/intro/)
4. Vérifier la longueur avec le tokenizer local du modèle choisi. Les passages de collecte sont réutilisables, mais certains devront être subdivisés avant l'embedding. Conserver le lien vers le passage parent et ses pages/articles ; ne pas tronquer silencieusement un article.
5. Créer les index de métadonnées nécessaires avant d'insérer les vecteurs. Faire les insertions par lots et enregistrer les identifiants des opérations. L'insertion Vectorize est asynchrone : vérifier que la mutation est traitée avant de déclarer l'index disponible. [Introduction à Vectorize](https://developers.cloudflare.com/vectorize/get-started/intro/)

L'import doit conserver toutes les versions utiles en D1/R2, mais l'index courant ne doit exposer que les passages autorisés par la politique du corpus. Lorsqu'une version est remplacée ou déclarée abrogée, retirer ses vecteurs de cet index et revalider le statut dans D1 au moment de la recherche. Une simple nouvelle insertion ne suffit pas à supprimer l'ancienne version.

## Métadonnées Vectorize proposées

Le champ `id` Vectorize reprend `chunk.id`. Les métadonnées restent courtes : `document_id`, `version_id`, `language`, `legal_status` et les indicateurs de catégories nécessaires au filtrage. `categories` peut servir à produire des indicateurs booléens par catégorie à l'import, sans changer le JSONL d'origine. Le passage complet et l'URL longue restent dans D1 ; les clés R2 et toutes les références restent accessibles par `version_id`.

Limites vérifiées pour les index Vectorize actuels : identifiant de vecteur de 64 octets au maximum, métadonnées de 10 KiB par vecteur, 10 index de métadonnées au maximum et lots d'upsert de 1 000 vecteurs via Workers ou 5 000 via l'API HTTP. Les identifiants hexadécimaux de 64 caractères ASCII du corpus respectent donc la limite. [Limites Vectorize](https://developers.cloudflare.com/vectorize/platform/limits/)

Les propriétés filtrables doivent être choisies avant insertion. Pour une propriété string indexée, seuls les premiers 64 octets sont indexés : préférer des identifiants et statuts courts aux URL, titres ou paragraphes. [Index de métadonnées Vectorize](https://developers.cloudflare.com/vectorize/get-started/intro/)

## Contraintes pratiques pour D1 et Workers

D1 limite une ligne, une chaîne ou un BLOB à 2 000 000 octets, une requête à 100 paramètres liés et une instruction SQL à 100 000 octets. La base est limitée à 500 MB sur Free et 10 GB sur Paid. Les PDF et textes complets sont donc conservés en R2 ; les passages bornés et leurs index restent en D1. Importer par lots courts avec des index sur les identifiants, `document_id`, `version_id` et l'état courant. [Limites D1](https://developers.cloudflare.com/d1/platform/limits/)

`DB.batch()` permet de regrouper les requêtes préparées : les instructions sont exécutées séquentiellement et une erreur annule le lot. Cela ne constitue pas une transaction entre D1, R2 et Vectorize ; l'import devra avoir un suivi de progression et pouvoir reprendre chaque phase séparément. [API D1 Database](https://developers.cloudflare.com/d1/worker-api/d1-database/)

Un Worker dispose de 128 MB de mémoire par isolate. Le transfert des PDF ou JSONL doit utiliser les streams ; éviter de charger un gros corpus avec `response.text()` ou `arrayBuffer()`. L'extraction PDF et l'OCR de cette étape restent dans la pipeline locale. [Streams dans Workers](https://developers.cloudflare.com/workers/runtime-apis/streams/)

## Contrat attendu pour Jev IA à l'étape 3

Le Worker exposera deux opérations séparées : `/v1/retrieve`, qui fonctionne sans LLM et renvoie les passages, et `/v1/chat`, qui ajoute la génération. Pour chaque résultat, la recherche renverra `chunk_id`, `document_id`, `version_id`, `text`, `title`, `number`, `date`, `article`, `page_start`, `page_end`, `source_url`, `language`, `legal_status` et le score de recherche. Les scores de modèles différents ne doivent pas être comparés comme s'ils avaient la même échelle.

Jev IA devra garder ces références avec le contexte envoyé au modèle et afficher les citations dans la réponse. La génération passe par une interface `ChatProvider` interne. Le premier adaptateur utilise l'API compatible OpenAI d'OpenRouter ; un adaptateur Ollama, vLLM, llama.cpp ou tout autre serveur compatible pourra le remplacer par configuration, sans modifier la recherche ni les citations. [API OpenRouter](https://openrouter.ai/docs/quickstart)

La configuration attendue sépare le fournisseur du code métier :

```text
LLM_BASE_URL=https://openrouter.ai/api/v1
Configurer `LLM_API_KEY` avec `wrangler secret put LLM_API_KEY`.
LLM_MODEL=<modèle OpenRouter choisi>
```

La clé reste un secret du Worker et n'est jamais envoyée au navigateur de Jev IA. Le nom du modèle, l'URL de base et la clé sont les seules dépendances propres au fournisseur. Les invites système, la construction du contexte et le format des citations restent dans l'application. Aucun binding Workers AI n'est créé.
