# Atelier: user guide

**Atelier** answers a research question from the published literature. You ask a question; it searches the academic databases, ranks and reads the papers, and writes a summary in which every claim is cited, with the papers listed underneath, best evidence first.

It uses DataSuite's AI to plan, read and write, and DataSuite's embeddings to rank papers by meaning. You need to be signed in to DataSuite.

> Atelier reads abstracts, and the full text where a paper is open access. It summarizes what the papers say; it does not replace reading the key papers yourself, and its summary is only as complete as what the databases returned.

## What happens when you ask

| Step | What it does |
| --- | --- |
| Plan the searches | The AI writes several differently worded queries for each database. |
| Ask the databases | PubMed, Europe PMC, OpenAlex, Semantic Scholar, Crossref and CORE are searched at the same time. |
| Complete and rank | Citation counts, journals and missing abstracts are filled in; papers are ranked by closeness to your question. |
| Screen every paper | The AI rates each candidate for how directly it answers the question. Off-topic papers are set aside. |
| Follow citations | From the best papers so far: what they cite, what cites them, and similar papers. If few papers answer the question, the search is repeated in other words. |
| Read the best papers | Going down the ranking until 20 papers answer the question. Population, methods, sample size and results are extracted, from the full text where it is open access. |
| Write the synthesis | A cited summary, with a table or list where it helps. |

The progress list shows each step with its numbers, so you can see how many papers were found, set aside, read and cited.

## Quick start

**1. Open Atelier**

Click the **Atelier** icon (a mortar-board) in the activity bar, the **Atelier** button in the status bar, or run **Atelier: Open Atelier** from the Command Palette.

**2. Ask a question**

Type a research question and press **Synthesize**. A full question works better than keywords, for example *"What are the socioeconomic barriers to breast cancer screening in sub-Saharan Africa?"*

**3. Read the answer**

The **Synthesis Summary** cites papers by number. Point at a number to see the paper; click it to jump to that paper in the **Results** below.

**4. Ask a follow-up**

Use the box at the bottom. Atelier answers from the papers already found, or searches again if they cannot answer. Tick papers first to ask about those alone.

## Reading the results

Each paper in **Results** shows its study design, how relevant the AI judged it, and where it was found. **Details** opens a summary written for your question, with the population, methods, sample size, outcomes and location.

| Label | Meaning |
| --- | --- |
| Yes / Possibly / Mixed / No | What the paper says to a yes/no question. |
| Full text read | The AI read the open-access full text, not only the abstract. |
| Highly cited | 100 or more citations, or 20 or more at 10 a year. |
| High-impact journal | The journal averages 5 or more citations per paper over two years. |
| Large sample | 1,000 or more participants. |
| Abstract may overstate | The abstract claims more than the full text shows. |

Papers are listed **best evidence first**: how directly the paper answers the question, then the strength of its study design (a meta-analysis before a cross-sectional study), then citations and journal. A paper's number is its place in that order.

Use the filters above the list to narrow by year, sample size, study design, open access or words, and **Table** to see the papers side by side.

### The Atelier Meter

For a yes/no question, the **Atelier Meter** shows how the cited papers answer it. Each paper is weighted by its study design and citations, so stronger evidence counts for more. It appears when at least three papers take a side.

### Teaching it what you mean

Use the thumbs up and thumbs down on a paper. Later searches in the same session look for more like the papers you approved, follow their citations, and leave out the ones you rejected.

## Downloading

**Download** on any query offers:

| Download | Contains |
| --- | --- |
| Report (PDF) | The summary, cited and referenced in your citation style, with the evidence table when **Table** is selected. |
| Tables (CSV) | The summary's tables and the evidence table. |
| Papers and extracted data (CSV) | Every reference with everything read from it. |
| References | A formatted list, or RIS (Zotero, EndNote, Mendeley) or BibTeX. |

Choose the **citation style** at the top of the Download menu or in Settings: Vancouver, AMA, IEEE, APA 7th or Harvard.

## Settings

Open **Settings** from the gear in Atelier's sidebar.

| Setting | What it controls |
| --- | --- |
| Contact email | Sent to PubMed and OpenAlex, as they ask of tools. |
| API keys | Optional keys for Semantic Scholar, PubMed, OpenAlex and CORE. They raise rate limits; a Semantic Scholar key is the most useful. Keys are kept in DataSuite's secret storage. |
| Databases | Which databases a search asks. |
| Follow citations | Whether a search follows the citations of the best papers it finds. |
| Model for screening and reading | A faster model here makes searches quicker. |
| Papers per database, References wanted, Most papers read | How wide and how deep a search goes. |
| Read full text | Whether open-access full text is read. |
| Citation style | How the PDF cites and lists references. |
| Data on this computer | Delete one session, all sessions, or everything Atelier keeps. |

## What Atelier keeps and sends

Sessions, the papers met in them and their embeddings are stored on your computer, in DataSuite's storage for the extension. A search sends your question and the papers' abstracts to DataSuite's AI and embeddings, and your queries to the literature databases.

## Limits to know

- **Coverage** depends on what the databases return and the citation trail reaches. A relevant paper that neither finds will not appear.
- **Full text** is read only for papers that are open access in Europe PMC. Others are read from the abstract, and marked so.
- **References** carry authors, title, journal, year and DOI, but not volume, issue or pages.
- **A search takes minutes**, not seconds: it makes many AI requests. The first-look answer appears while the papers are read.
