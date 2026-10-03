# Atelier

Research synthesis in DataSuite. Ask a question; Atelier

1. **plans** a query for each database with DataSuite's AI,
2. **asks** PubMed, Europe PMC, OpenAlex, Semantic Scholar, Crossref and CORE at the same time (several queries each,
   in different words), recalls the papers it already knows that are close to the question, follows the citations of
   the best papers found, and searches again in other words when few answer the question,
3. **ranks** the unique papers. Relevance first: the AI rates every candidate against the question from its title and
   abstract (a batch a request), blended with closeness to the topic -- DataSuite's embeddings (cosine similarity)
   and keywords (BM25). Quality second, and only between papers of like relevance: citations, recency, the study
   design's evidence tier, how cited the journal is, being found by several databases. Papers that came without an
   abstract get one from PubMed or Europe PMC first; the keyword weight is fitted on what past screenings found
   relevant,
4. **reads** down the ranking with the AI until enough papers answer the question -- screening each in full and
   extracting population, methods, results, outcomes, sample size, duration and location. Papers the first rating
   found off-topic are not read,
5. **writes** a cited summary from those that passed. `[n]` in the text is the n-th paper under it.

For a yes/no question the **Atelier Meter** shows how the cited papers answer it -- yes, possibly, mixed, no -- each
paper weighted by its evidence tier and citations. Before ranking, OpenAlex adds each candidate's citations, an
open-access PDF and how cited its journal is; where a paper is open access in Europe PMC, the AI reads its full text
beside the abstract and says when the abstract overstates the findings. A paper's details open with a summary written
for the question. The papers can be filtered (year, sample size, design, what they say, open access, words) and sorted.

A follow-up is answered from the papers at hand, or -- when they can't answer it -- starts a new search. Tick papers to
ask about those alone. Sessions are kept and listed under History; a query's papers export to CSV.

Open it from Atelier's view in the side bar (the mortar-board icon: your sessions, with Open Atelier, New Search and
History in its title), the **Atelier** button in the status bar, or **Atelier: Open Atelier** in the Command Palette.

**Download** on a query saves it: the report as a PDF laid out as it is on screen, its tables as CSV, its papers with
everything extracted from them as CSV, and its references as a formatted list or for a reference manager (RIS,
BibTeX).

This is the DataSuite port of the Python/Dash app of the same name (github.com/damurka/atelier).

## What it uses of DataSuite

- **Chat models** (`vscode.lm`): the model picked in Atelier plans, reads and writes. No API key is held here; the
  sign-in and quota are the user's own. DataSuite asks once whether Atelier may use the models.
- **Embeddings** (`google/gemini-embedding-2`, 768 dimensions; datasuite `docs/adr/0028`): through the
  `datasuite.embeddings.compute` command, or the proposed API `embeddings`. DataSuite has to know the extension for
  either: `datasuite.atelier` is in `product.json`'s `extensionEnabledApiProposals` and in
  `EMBEDDINGS_COMMAND_EXTENSIONS` (datasuite-assistant). In a DataSuite built before that, signed out, or with
  `datasuite.embeddings.enabled` off, papers are ranked by keywords (BM25) instead and everything else works the same.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `atelier.maxResultsPerSource` | 50 | Papers asked of each database per search. |
| `atelier.referencesWanted` | 20 | The papers a synthesis aims to cite: the AI reads down the ranking until this many answer the question. |
| `atelier.papersToRead` | 60 | The most papers the AI reads for one search (one request each). |
| `atelier.readFullText` | on | Read the open-access full text (Europe PMC) of papers that have one. |
| `atelier.databases` | all but arXiv | The databases a search asks. |
| `atelier.followCitations` | on | Follow the citations of the best papers a search finds. |
| `atelier.workModel` | | The model that screens and reads the papers; empty: the question's own. |
| `atelier.citationStyle` | Vancouver | How the PDF report cites in its text and writes its references: Vancouver, AMA, IEEE, APA 7th or Harvard. |
| `atelier.contactEmail` | | Optional; sent to NCBI and OpenAlex, as they ask of tools. |

These are also on Atelier's own **Settings** page (the gear in its sidebar), with the databases' API keys -- Semantic
Scholar, NCBI, OpenAlex; they answer without keys, with lower limits -- which are kept in DataSuite's secret storage,
and with what is stored on this computer: delete one session (History, or its own page), all sessions, or everything.

## Releasing

`npm version <patch|minor|major>` and push the tag: CI (`.github/workflows/ci.yml`) typechecks, tests and packages the
`.vsix`, publishes it to the DataSuite registry (it needs the repository secret `OVSX_PAT`) and makes a GitHub release
whose notes give the `product.json` pin for DataSuite's `builtInExtensions`.

Embeddings need DataSuite to know the extension: `datasuite.atelier` in `product.json`'s
`extensionEnabledApiProposals` and in `EMBEDDINGS_COMMAND_EXTENSIONS` (datasuite-assistant). A DataSuite built without
them ranks by keywords.

The user guide is on the docs site: `docs-site/src/content/en/apps/atelier.mdx` in `datasuite-identity`.

## Where things are kept

In the extension's global storage: `papers.json` (every paper met, once, by its fingerprint -- DOI, else PMID, PMCID,
arXiv id), `vectors.json` (their embeddings), `sessions.json`, and `judgments.json` (what screenings found relevant, for the
ranking's keyword weight).

## Development

```
npm install
npm run build        # out/extension.js and out/webview.js (React)
npm run watch
npm run typecheck
npm test             # the pure parts: identifiers, ranking, the databases' records, merging
```

| | |
| --- | --- |
| `src/pipeline.ts` | One query, from the prompt to its synthesis. |
| `src/ai/` | The prompts and the calls to the chat model; embeddings. |
| `src/search/` | The four databases, the HTTP client (throttle, retries), merging. |
| `src/core/` | Identifiers and fingerprints; scoring. No `vscode`. |
| `src/store.ts` | Papers, vectors, sessions on disk. |
| `src/webview/` | The React app. It asks the host for everything (`src/shared/api.ts`). |
